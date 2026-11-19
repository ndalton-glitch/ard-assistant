// Reading documents once, caching their text, and sorting dropped files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const isImage = f => !!IMAGE_EXT[path.extname(f).toLowerCase()];
const isPdf = f => path.extname(f).toLowerCase() === '.pdf';
const isDocx = f => path.extname(f).toLowerCase() === '.docx';
const isText = f => ['.txt', '.md', '.rtf', '.html', '.htm'].includes(path.extname(f).toLowerCase());

function cachePath(file) {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 16);
  const dir = path.join(path.dirname(path.dirname(file)), '.ard-cache');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, path.basename(file) + '.' + key + '.txt');
}

// Local (free) text extraction. Returns '' when the file needs the AI to read it (scans, images).
async function localText(file) {
  if (isPdf(file)) {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(fs.readFileSync(file));
    const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
    // Scanned PDFs have almost no text layer.
    if (text.length < 80 * Math.max(1, data.numpages || 1) / 4) return '';
    return text;
  }
  if (isDocx(file)) {
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ path: file });
    return (r.value || '').trim();
  }
  if (isText(file)) {
    let t = fs.readFileSync(file, 'utf8');
    if (/\.html?$/i.test(file)) t = t.replace(/<[^>]+>/g, ' ');
    return t.trim();
  }
  return '';
}

function readCached(file) {
  try { return fs.readFileSync(cachePath(file), 'utf8'); } catch { return null; }
}
function writeCached(file, text) { fs.writeFileSync(cachePath(file), text); }

// Get text for a document, reading it at most once. aiReader(file) is used for scans/images.
async function getText(file, aiReader) {
  const cached = readCached(file);
  if (cached !== null) return { text: cached, fromCache: true };
  let text = '';
  try { text = await localText(file); } catch (e) { text = ''; }
  if (!text && aiReader && (isPdf(file) || isImage(file))) text = await aiReader(file);
  if (text) writeCached(file, text);
  return { text, fromCache: false };
}

// ---------- sorting dropped files ----------
const CAT_PATTERNS = [
  ['FIE', /\b(fie|full\s+(and\s+)?individual(ized)?\s+evaluation|psycho.?educational|reevaluation|re-?eval)\b/i],
  ['IEP', /\b(iep|individuali[sz]ed\s+education(al)?\s+program|ard\s+(paperwork|document|deliberations?))\b/i],
  ['STAAR', /\b(staar|state\s+of\s+texas\s+assessment)/i],
  ['MAP', /\b(map(\s+growth)?|nwea|rit\s+score)\b/i],
  ['Progress Report', /\b(progress(\s+report)?|ipr|goal\s+progress)\b/i],
];
function guessCategory(fileName, text) {
  const base = path.basename(fileName).replace(/[_\-.]+/g, ' ');
  for (const [cat, re] of CAT_PATTERNS) if (re.test(base)) return cat;
  if (text) {
    const head = text.slice(0, 4000);
    for (const [cat, re] of CAT_PATTERNS) if (re.test(head)) return cat;
  }
  return isImage(fileName) ? 'MAP' : 'Other';
}

function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function guessStudent(fileName, text, students) {
  const base = ' ' + norm(path.basename(fileName, path.extname(fileName))) + ' ';
  const hay = text ? ' ' + norm(text.slice(0, 5000)) + ' ' : '';
  const scored = [];
  for (const s of students) {
    const parts = norm(s.name).split(' ').filter(x => x.length > 1);
    if (!parts.length) continue;
    const first = parts[0], last = parts[parts.length - 1];
    let score = 0;
    if (base.includes(' ' + last + ' ')) score += 2;
    if (base.includes(' ' + first + ' ')) score += 1;
    if (!score && hay) {
      if (hay.includes(' ' + last + ' ')) score += 1.5;
      if (hay.includes(' ' + first + ' ')) score += 0.5;
    }
    if (score) scored.push({ name: s.name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return '';
  const [top, next] = scored;
  // A last name is enough; a first name alone counts only when no other student shares it.
  if (top.score >= 1.5 && (!next || next.score < top.score)) return top.name;
  if (top.score >= 1 && !next) return top.name;
  return '';
}

async function analyzeDrop(paths) {
  const students = store.listStudents();
  const out = [];
  for (const file of paths) {
    let text = '';
    try { if (!isImage(file)) text = await localText(file); } catch {}
    out.push({ path: file, name: path.basename(file), category: guessCategory(file, text), student: guessStudent(file, text, students) });
  }
  return out;
}

// Copy (never move) a file into a student's category folder.
function importFile(src, studentName, category) {
  if (!store.CATEGORIES.includes(category)) category = 'Other';
  const dir = path.join(store.studentDir(studentName), category);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(src), base = path.basename(src, ext);
  let dest = path.join(dir, base + ext), i = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, `${base} (${i++})${ext}`);
  fs.copyFileSync(src, dest);
  // Keep the original file date so stale-data checks use the real document date.
  try { const st = fs.statSync(src); fs.utimesSync(dest, st.atime, st.mtime); } catch {}
  return dest;
}

module.exports = { IMAGE_EXT, isImage, isPdf, isDocx, getText, localText, analyzeDrop, importFile, guessCategory, guessStudent };
