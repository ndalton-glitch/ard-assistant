// All calls to the Anthropic API live here.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');
const docs = require('./docs');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client() {
  const apiKey = store.getApiKey();
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  return new Anthropic({ apiKey, maxRetries: 3 });
}

function textOf(msg) {
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// One request, streamed to avoid timeouts on long drafts; usage is logged for the cost tracker.
async function run({ student, kind, system, content, maxTokens = 32000, effort = 'medium', format }) {
  const model = store.getSettings().model;
  const params = {
    model,
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort, ...(format ? { format } : {}) },
    messages: [{ role: 'user', content }],
  };
  if (system) params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  let msg;
  try {
    msg = await client().beta.messages.stream(params).finalMessage();
  } catch (e) {
    throw new Error(friendlyError(e));
  }
  const usedModel = store.MODELS[msg.model] ? msg.model : model;
  const cost = store.costOf(usedModel, msg.usage || {});
  store.recordUsage({
    ts: new Date().toISOString(), student: student || '', kind, model: usedModel,
    input: msg.usage.input_tokens || 0, output: msg.usage.output_tokens || 0,
    cacheRead: msg.usage.cache_read_input_tokens || 0, cacheWrite: msg.usage.cache_creation_input_tokens || 0, cost,
  });
  if (msg.stop_reason === 'refusal') throw new Error('The model declined this request. Try again, or switch models in Settings.');
  if (msg.stop_reason === 'max_tokens') throw new Error('The response was cut off because it ran too long. Try again.');
  return { text: textOf(msg), cost };
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check it in Settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Your API key does not have access to this model.';
  if (e instanceof Anthropic.RateLimitError) return 'The API is busy or your account hit a rate limit. Wait a minute and try again.';
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(e.message)) return 'Your Anthropic account is out of credits. Add credits at console.anthropic.com.';
    return 'The request was rejected: ' + e.message;
  }
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `API error ${e.status || ''}: ${e.message}`;
  return e.message || String(e);
}

function fileBlock(file) {
  const data = fs.readFileSync(file).toString('base64');
  if (docs.isPdf(file)) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const mt = docs.IMAGE_EXT[path.extname(file).toLowerCase()];
  if (mt) return { type: 'image', source: { type: 'base64', media_type: mt, data } };
  return null;
}

// Used once per scanned PDF or image document; the text is cached on disk afterward.
function makeReader(studentName) {
  return async (file) => {
    const block = fileBlock(file);
    if (!block) return '';
    const r = await run({
      student: studentName, kind: 'read document', effort: 'low', maxTokens: 32000,
      content: [block, { type: 'text', text: 'Transcribe all of the text in this document faithfully, keeping tables as simple text tables. Output only the transcription.' }],
    });
    return r.text;
  };
}

async function testKey() {
  const r = await run({ kind: 'key test', effort: 'low', maxTokens: 50, content: 'Reply with the word OK.' });
  return r.text;
}

// ---------- score extraction for the data check ----------
const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['map', 'staar', 'progress'],
  properties: {
    map: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['subject', 'term', 'rit', 'percentile', 'notes'],
      properties: { subject: { type: 'string' }, term: { type: 'string' }, rit: { type: 'string' }, percentile: { type: 'string' }, notes: { type: 'string' } } } },
    staar: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['subject', 'year', 'scaleScore', 'performance', 'notes'],
      properties: { subject: { type: 'string' }, year: { type: 'string' }, scaleScore: { type: 'string' }, performance: { type: 'string' }, notes: { type: 'string' } } } },
    progress: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['goal', 'status', 'notes'],
      properties: { goal: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } } } },
  },
};

async function extractScores(student, which = ['map', 'staar', 'progress']) {
  const content = [];
  const catFor = { map: 'MAP', staar: 'STAAR', progress: 'Progress Report' };
  const reader = makeReader(student.name);
  for (const key of which) {
    const files = student.files.filter(f => f.category === catFor[key]);
    for (const f of files) {
      if (docs.isImage(f.path) || docs.isPdf(f.path)) {
        // Screenshots go straight to the model. Text PDFs are read locally to save tokens.
        let text = '';
        if (docs.isPdf(f.path)) { try { text = await docs.localText(f.path); } catch {} }
        if (text) content.push({ type: 'text', text: `<file category="${catFor[key]}" name="${f.name}" date="${f.date}">\n${text}\n</file>` });
        else { content.push({ type: 'text', text: `File: ${catFor[key]} - ${f.name} (${f.date})` }); content.push(fileBlock(f.path)); }
      } else {
        const { text } = await docs.getText(f.path, reader);
        if (text) content.push({ type: 'text', text: `<file category="${catFor[key]}" name="${f.name}" date="${f.date}">\n${text}\n</file>` });
      }
    }
  }
  if (!content.length) return { map: [], staar: [], progress: [] };
  content.push({ type: 'text', text:
`These are ${student.name}'s assessment screenshots and progress report. Extract the data exactly as shown.
- map: one row per subject and term from NWEA MAP Growth (RIT score, percentile; put growth, projected proficiency, or lexile/quantile in notes).
- staar: one row per subject and year from STAAR (scale score, performance level such as Did Not Meet Grade Level, Approaches, Meets, Masters; put retest or accommodations info in notes).
- progress: one row per IEP annual goal from the most recent progress report (short goal description, status such as Mastered / Progressing / Not progressing / Not yet introduced, and any data or comments in notes).
Leave an array empty if there is no data for it. Use an empty string for any value not shown. Never guess a number.` });
  const r = await run({ student: student.name, kind: 'read scores', effort: 'low', maxTokens: 16000, content,
    format: { type: 'json_schema', schema: SCORE_SCHEMA } });
  try { return JSON.parse(r.text); } catch { throw new Error('Could not read the scores. Try again.'); }
}

// ---------- drafting ----------
const SYSTEM = `You are an experienced Texas special education case manager who writes ARD (Admission, Review, and Dismissal) committee meeting summaries. You know IDEA, Texas Education Code and TEA terminology: IEP, FIE, REED, PLAAFP, STAAR (including STAAR Alternate 2), NWEA MAP Growth, accommodations, designated supports, LRE, and schedule of services.

Rules you always follow:
1. Use only facts found in the provided documents and confirmed scores. Never invent scores, dates, goals, services, or decisions.
2. When something needed for a section is not in the documents, write a placeholder in square brackets that says what is needed, like [NEEDS INPUT: parent concerns] or [VERIFY: minutes of inclusion support].
3. In the Present Levels section, note the source of each data point in parentheses, for example (FIE, 03/2025), (MAP Growth, Winter 2026), (STAAR 2025), (Progress Report, 10/2026), (IEP, 12/2025).
4. Decisions made during the meeting itself (agreement, final placement, signatures) are written as placeholders unless the documents state them.
5. Follow the user's template sections, order, tone, and the style of their example summary when one is provided.
6. Output the summary in Markdown: '#' for the title, '##' for section headings, short paragraphs and bullet lists, and Markdown tables where data is tabular. Output only the summary, with no preamble.`;

const ORDER = ['IEP', 'FIE', 'Progress Report', 'MAP', 'STAAR', 'Other'];

async function buildDocBlock(student) {
  const reader = makeReader(student.name);
  const files = [...student.files].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.name.localeCompare(b.name));
  const parts = [];
  for (const f of files) {
    // MAP and STAAR come in as confirmed scores; their screenshots are only read during the data check.
    if ((f.category === 'MAP' || f.category === 'STAAR') && docs.isImage(f.path)) continue;
    const { text } = await docs.getText(f.path, reader);
    if (text) parts.push(`<document category="${f.category}" file="${f.name}" date="${f.date}">\n${text}\n</document>`);
  }
  return parts.join('\n\n') || '(No documents are on file for this student.)';
}

function scoresText(student) {
  const s = student.scores || {};
  const out = [];
  const table = (rows, cols) => rows.map(r => '- ' + cols.map(c => `${c}: ${r[c] || '-'}`).join('; ')).join('\n');
  if (s.map && s.map.rows && s.map.rows.length) out.push(`MAP Growth${s.map.confirmed ? ' (confirmed by teacher)' : ' (NOT yet confirmed)'}:\n` + table(s.map.rows, ['subject', 'term', 'rit', 'percentile', 'notes']));
  if (s.staar && s.staar.rows && s.staar.rows.length) out.push(`STAAR${s.staar.confirmed ? ' (confirmed by teacher)' : ' (NOT yet confirmed)'}:\n` + table(s.staar.rows, ['subject', 'year', 'scaleScore', 'performance', 'notes']));
  if (s.progress && s.progress.rows && s.progress.rows.length) out.push(`Progress on current goals${s.progress.confirmed ? ' (confirmed by teacher)' : ' (NOT yet confirmed)'}:\n` + table(s.progress.rows, ['goal', 'status', 'notes']));
  const na = Object.keys(student.na || {}).filter(k => student.na[k]);
  if (na.length) out.push('Marked not applicable for this student: ' + na.join(', '));
  return out.join('\n\n') || 'No confirmed scores were entered.';
}

function templateText(t) {
  let s = `Template: ${t.name}\nSections, in order:\n${t.sections}\n`;
  if (t.instructions) s += `\nStyle instructions: ${t.instructions}\n`;
  if (t.example) s += `\nExample of a past summary to match in format and tone (do not copy its facts):\n<example>\n${t.example}\n</example>\n`;
  return s;
}

function meetingText(student) {
  return `Student: ${student.name}\nGrade: ${student.grade || '[NEEDS INPUT]'}\nCampus: ${student.campus || '[NEEDS INPUT]'}\nARD date: ${student.ardDate || '[NEEDS INPUT]'}\nMeeting type: ${student.ardType || 'Annual'}\nTeacher notes: ${student.notes || 'none'}`;
}

// The documents block is first and cached, so revisions only pay full price for the new parts.
async function prefix(student) {
  return [{ type: 'text', text: `<student_documents>\n${await buildDocBlock(student)}\n</student_documents>`, cache_control: { type: 'ephemeral' } }];
}

async function draft(student, template, extra) {
  const content = await prefix(student);
  content.push({ type: 'text', text: `${meetingText(student)}\n\n<scores>\n${scoresText(student)}\n</scores>\n\n${templateText(template)}\n${extra ? 'Additional instructions for this draft: ' + extra + '\n' : ''}\nWrite the ARD summary now.` });
  return run({ student: student.name, kind: 'draft', system: SYSTEM, content, effort: 'medium' });
}

async function revise(student, template, current, instruction) {
  const content = await prefix(student);
  content.push({ type: 'text', text: `${meetingText(student)}\n\n<scores>\n${scoresText(student)}\n</scores>\n\n${templateText(template)}\n\nHere is the current draft, which the teacher may have edited by hand. Keep their edits.\n<current_draft>\n${current}\n</current_draft>\n\nRevise it as follows: ${instruction}\n\nOutput the full revised summary.` });
  return run({ student: student.name, kind: 'revise', system: SYSTEM, content, effort: 'medium' });
}

module.exports = { testKey, extractScores, draft, revise, makeReader, friendlyError };
