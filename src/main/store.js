// Local storage: settings, API key, students (folders on disk), templates, usage log.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const CATEGORIES = ['IEP', 'FIE', 'MAP', 'STAAR', 'Progress Report', 'Other'];
const REQUIRED = ['IEP', 'FIE', 'MAP', 'STAAR', 'Progress Report'];

const MODELS = {
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 (recommended, lower cost)', input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  'claude-opus-5-5': { label: 'Claude Opus 5.5 (most capable, about 2x cost)', input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5 },
};

const userDir = () => app.getPath('userData');
const p = (...a) => path.join(userDir(), ...a);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  dataRoot: '',
  theme: 'dark',
  model: 'claude-sonnet-5-5',
  reminderDays: [14, 3],
  runInTray: true,
  startWithWindows: false,
  staleProgressDays: 75,
  staleMapDays: 150,
  notified: {},
  defaultTemplateId: 'standard',
};
function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJSON(p('settings.json'), {}) };
  if (!s.dataRoot) s.dataRoot = path.join(app.getPath('documents'), 'ARD Assistant');
  if (!MODELS[s.model]) s.model = DEFAULT_SETTINGS.model;
  return s;
}
function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  writeJSON(p('settings.json'), s);
  return s;
}

// ---------- API key (encrypted with Windows DPAPI via safeStorage) ----------
function setApiKey(key) {
  const file = p('apikey.bin');
  if (!key) { for (const f of [file, file + '.plain']) { try { fs.unlinkSync(f); } catch {} } return; }
  if (!safeStorage.isEncryptionAvailable()) {
    // Developer testing on Linux without a keyring only; Windows always has DPAPI.
    if (process.platform !== 'win32' && process.env.ARD_ALLOW_PLAIN_KEY === '1') { fs.writeFileSync(file + '.plain', key.trim()); return; }
    throw new Error('Windows encryption is not available on this account.');
  }
  fs.writeFileSync(file, safeStorage.encryptString(key.trim()));
}
function getApiKey() {
  try { return safeStorage.decryptString(fs.readFileSync(p('apikey.bin'))); } catch {}
  if (process.platform !== 'win32' && process.env.ARD_ALLOW_PLAIN_KEY === '1') { try { return fs.readFileSync(p('apikey.bin.plain'), 'utf8'); } catch {} }
  return '';
}

// ---------- students ----------
function root() {
  const r = getSettings().dataRoot;
  fs.mkdirSync(r, { recursive: true });
  return r;
}
function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function studentDir(name) { return path.join(root(), safeName(name)); }

function listFilesIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.startsWith('~$'))
      .map(d => d.name);
  } catch { return []; }
}

function loadStudent(name) {
  const dir = studentDir(name);
  const meta = readJSON(path.join(dir, 'student.json'), null);
  if (!meta) return null;
  const files = [];
  for (const cat of CATEGORIES) {
    for (const f of listFilesIn(path.join(dir, cat))) {
      const full = path.join(dir, cat, f);
      const st = fs.statSync(full);
      const rel = cat + '/' + f;
      files.push({ category: cat, name: f, rel, path: full, size: st.size,
        date: (meta.docDates && meta.docDates[rel]) || st.mtime.toISOString().slice(0, 10) });
    }
  }
  const drafts = listFilesIn(path.join(dir, 'Drafts'))
    .filter(f => f.endsWith('.html'))
    .map(f => ({ name: f, path: path.join(dir, 'Drafts', f), mtime: fs.statSync(path.join(dir, 'Drafts', f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return { ...meta, dir, files, drafts, status: computeStatus(meta, files) };
}

function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10); }

function computeStatus(meta, files) {
  const s = getSettings();
  const na = meta.na || {};
  const items = [];
  const ref = meta.ardDate || today();
  for (const cat of REQUIRED) {
    if (na[cat]) { items.push({ cat, state: 'na', note: 'not applicable' }); continue; }
    const fs_ = files.filter(f => f.category === cat).sort((a, b) => b.date.localeCompare(a.date));
    if (!fs_.length) { items.push({ cat, state: 'missing', note: 'missing' }); continue; }
    const newest = fs_[0].date;
    const age = daysBetween(newest, ref);
    let state = 'ok', note = 'dated ' + newest;
    if (cat === 'Progress Report' && age > s.staleProgressDays) { state = 'stale'; note = `from ${newest}, may be stale`; }
    if (cat === 'MAP' && age > s.staleMapDays) { state = 'stale'; note = `from ${newest}, may be stale`; }
    if (cat === 'FIE' && age > 365 * 3 - 60) { state = 'stale'; note = `FIE from ${newest}, reevaluation may be due`; }
    items.push({ cat, state, note });
  }
  const needed = items.filter(i => i.state !== 'na');
  const have = needed.filter(i => i.state !== 'missing').length;
  const scores = meta.scores || {};
  const unconfirmed = ['map', 'staar', 'progress'].filter(k => {
    const cat = { map: 'MAP', staar: 'STAAR', progress: 'Progress Report' }[k];
    return !na[cat] && files.some(f => f.category === cat) && !(scores[k] && scores[k].confirmed);
  });
  return { items, have, total: needed.length, ready: have === needed.length, unconfirmed,
    daysUntil: meta.ardDate ? daysBetween(today(), meta.ardDate) : null };
}

function listStudents() {
  const r = root();
  const out = [];
  for (const d of fs.readdirSync(r, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const st = loadStudent(d.name);
    if (st) out.push(st);
  }
  out.sort((a, b) => (a.ardDate || '9999').localeCompare(b.ardDate || '9999') || a.name.localeCompare(b.name));
  return out;
}

function saveStudent(data, originalName) {
  const name = safeName(data.name);
  if (!name) throw new Error('Student name is required.');
  if (originalName && safeName(originalName) !== name) {
    const from = studentDir(originalName), to = studentDir(name);
    if (fs.existsSync(to)) throw new Error('A student with that name already exists.');
    fs.renameSync(from, to);
  }
  const dir = studentDir(name);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of [...CATEGORIES, 'Drafts']) fs.mkdirSync(path.join(dir, c), { recursive: true });
  const existing = readJSON(path.join(dir, 'student.json'), {});
  const keep = ['name', 'grade', 'campus', 'ardDate', 'ardType', 'notes', 'templateId', 'na', 'scores', 'docDates', 'created'];
  const merged = { ...existing };
  for (const k of keep) if (data[k] !== undefined) merged[k] = data[k];
  merged.name = name;
  merged.created = merged.created || new Date().toISOString();
  writeJSON(path.join(dir, 'student.json'), merged);
  return loadStudent(name);
}

function patchStudent(name, patch) {
  const dir = studentDir(name);
  const cur = readJSON(path.join(dir, 'student.json'), null);
  if (!cur) throw new Error('Student not found: ' + name);
  writeJSON(path.join(dir, 'student.json'), { ...cur, ...patch });
  return loadStudent(name);
}

// ---------- templates ----------
const DEFAULT_TEMPLATE = {
  id: 'standard',
  name: 'Standard ARD Summary',
  sections: [
    'Meeting Information (student, grade, campus, ARD date, meeting type)',
    'Purpose of the Meeting',
    'Eligibility (disability categories from the FIE, date of most recent FIE, whether reevaluation is due)',
    'Present Levels of Academic Achievement and Functional Performance (reading, math, writing, and other areas; strengths and needs)',
    'Assessment Data (MAP Growth results and growth; STAAR results by subject and year)',
    'Progress on Current Annual Goals (each goal with mastery status from the progress report)',
    'Proposed Annual Goals (areas of need to be addressed)',
    'Accommodations and Supports',
    'State Assessment Participation',
    'Services and Placement',
    'Committee Considerations and Parent Input (leave placeholders for items decided at the meeting)',
  ].join('\n'),
  instructions: 'Write in a professional, parent-friendly tone. Use third person and the student\'s first name. Keep each section concise.',
  example: '',
  builtIn: true,
};
function listTemplates() {
  const dir = p('templates');
  fs.mkdirSync(dir, { recursive: true });
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(dir, f), null)).filter(Boolean);
  if (!list.find(t => t.id === 'standard')) list.unshift(DEFAULT_TEMPLATE);
  return list;
}
function saveTemplate(t) {
  const id = t.id || ('t' + Date.now());
  const out = { ...t, id };
  writeJSON(p('templates', id + '.json'), out);
  return out;
}
function deleteTemplate(id) {
  if (id === 'standard') { try { fs.unlinkSync(p('templates', 'standard.json')); } catch {} return; }
  try { fs.unlinkSync(p('templates', id + '.json')); } catch {}
}
function getTemplate(id) {
  const all = listTemplates();
  return all.find(t => t.id === id) || all.find(t => t.id === getSettings().defaultTemplateId) || all[0];
}

// ---------- usage / cost ----------
function costOf(model, u) {
  const m = MODELS[model] || MODELS['claude-sonnet-5-5'];
  return ((u.input_tokens || 0) * m.input + (u.output_tokens || 0) * m.output +
    (u.cache_read_input_tokens || 0) * m.cacheRead + (u.cache_creation_input_tokens || 0) * m.cacheWrite) / 1e6;
}
function recordUsage(entry) {
  const log = readJSON(p('usage.json'), []);
  log.push(entry);
  writeJSON(p('usage.json'), log);
}
function getUsage() { return readJSON(p('usage.json'), []); }

module.exports = {
  CATEGORIES, REQUIRED, MODELS, getSettings, saveSettings, setApiKey, getApiKey,
  root, safeName, studentDir, loadStudent, listStudents, saveStudent, patchStudent,
  listTemplates, saveTemplate, deleteTemplate, getTemplate, costOf, recordUsage, getUsage,
  readJSON, writeJSON, today, daysBetween,
};
