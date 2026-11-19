/* ARD Assistant renderer. Plain JS, no framework. */
// window.api comes from preload.js
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (n || 0).toFixed(n && n < 0.1 ? 3 : 2);
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '-';
const CATS = ['IEP', 'FIE', 'MAP', 'STAAR', 'Progress Report', 'Other'];
const ARD_TYPES = ['Annual', 'REED', 'Amendment', 'Initial', 'Transfer', 'Dismissal', 'Other'];
let settings = {};
let route = 'dashboard';
const state = { tab: 'docs', draftFile: null, templateId: null, batch: {} };

// ---------- helpers ----------
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', err ? 7000 : 3500);
}
async function call(ch, ...a) {
  try { return await api.call(ch, ...a); } catch (e) { toast(e.message, true); throw e; }
}
function modal(html, onMount) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#modalBox'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
function busy(btn, text) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${esc(text)}`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
}
function sanitize(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  d.querySelectorAll('script,style,iframe,object,embed,link,meta,img').forEach(n => n.remove());
  d.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (/^on/i.test(a.name) || /^(href|src)$/i.test(a.name)) n.removeAttribute(a.name); }));
  return d.innerHTML;
}
function highlightPlaceholders(html) {
  return html.replace(/(<mark>)?\[(NEEDS INPUT|VERIFY)([^\]<]*)\](<\/mark>)?/g, '<mark>[$2$3]</mark>');
}
function barColor(st) {
  if (st.ready) return 'var(--ok)';
  const r = st.have / Math.max(1, st.total);
  return r >= 0.75 ? 'var(--accent)' : r >= 0.5 ? 'var(--warn)' : 'var(--bad)';
}
function daysCell(d) {
  if (d === null || d === undefined) return '<span class="muted">no date</span>';
  if (d < 0) return `<span class="muted">${-d} days ago</span>`;
  const cls = d <= 3 ? 'bad' : d <= 14 ? 'warn' : '';
  return `<b class="${cls}">${d === 0 ? 'Today' : d + (d === 1 ? ' day' : ' days')}</b>`;
}

// ---------- theme ----------
function applyTheme(t) {
  document.body.classList.toggle('light', t === 'light');
  $('#themeToggle').checked = t === 'light';
  $('#themeLabel').textContent = t === 'light' ? 'Light mode' : 'Dark mode';
}
$('#themeToggle').addEventListener('change', async e => {
  const t = e.target.checked ? 'light' : 'dark';
  applyTheme(t); settings = await call('settings:save', { theme: t });
});

// ---------- routing ----------
function go(r) { location.hash = r; }
window.addEventListener('hashchange', () => render());
$$('#nav a').forEach(a => a.addEventListener('click', () => go(a.dataset.route)));
api.on('navigate', r => go(r));

async function render() {
  route = location.hash.slice(1) || 'dashboard';
  const [base, arg] = route.split('/');
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.route === base || (base === 'student' && a.dataset.route === 'students')));
  const views = { dashboard, students, student, batch, templates, reminders, costs, settings: settingsView };
  const main = $('#main');
  try { await (views[base] || dashboard)(main, arg ? decodeURIComponent(arg) : null); }
  catch (e) { main.innerHTML = `<div class="card bad">Something went wrong: ${esc(e.message)}</div>`; }
}

// ---------- dashboard ----------
async function dashboard(main) {
  const list = await call('students:list');
  const usage = await call('usage:get');
  const month = new Date().toISOString().slice(0, 7);
  const monthCost = usage.filter(u => u.ts.startsWith(month)).reduce((a, u) => a + u.cost, 0);
  const upcoming = list.filter(s => s.status.daysUntil === null || s.status.daysUntil >= 0);
  const next30 = upcoming.filter(s => s.status.daysUntil !== null && s.status.daysUntil <= 30);
  const missing = [];
  for (const s of upcoming) for (const i of s.status.items) if (i.state === 'missing' || i.state === 'stale') missing.push({ s, i });
  for (const s of upcoming) for (const k of s.status.unconfirmed) missing.push({ s, i: { cat: { map: 'MAP', staar: 'STAAR', progress: 'Progress' }[k] + ' scores', note: 'not checked yet', state: 'check' } });
  const readyCount = upcoming.filter(s => s.status.ready).length;

  main.innerHTML = `
  ${!settings.hasKey ? `<div class="note">Welcome! To start, add your Anthropic API key in <a data-go="settings">Settings</a>. Then add your students, or just drop their files anywhere in this window.</div>` : ''}
  <div class="top"><div><h1>Upcoming ARDs</h1><div class="sub">Sorted by meeting date. Files live in ${esc(settings.dataRoot)}</div></div>
    <div class="btns"><button id="addStu">+ Add student</button><button class="p" data-go="batch">Batch draft ready summaries</button></div></div>
  <div class="stats">
    <div class="card stat"><div class="l">ARDs next 30 days</div><div class="v">${next30.length}</div></div>
    <div class="card stat"><div class="l">Ready to draft</div><div class="v">${readyCount}</div></div>
    <div class="card stat"><div class="l">Missing items</div><div class="v">${missing.filter(m => m.i.state !== 'check').length}</div></div>
    <div class="card stat"><div class="l">API cost this month</div><div class="v">${money(monthCost)}</div></div>
  </div>
  <div class="grid2">
    <div class="card">${upcoming.length ? `<table>
      <tr><th>Student</th><th>ARD date</th><th>In</th><th>Type</th><th>Readiness</th></tr>
      ${upcoming.map(s => `<tr class="click" data-stu="${esc(s.name)}"><td>${esc(s.name)}</td><td>${fmtDate(s.ardDate)}</td><td>${daysCell(s.status.daysUntil)}</td>
        <td><span class="chip">${esc(s.ardType || 'Annual')}</span></td>
        <td><span class="bar"><b style="width:${Math.round(100 * s.status.have / Math.max(1, s.status.total))}%;background:${barColor(s.status)}"></b></span><span class="pct">${s.status.have} of ${s.status.total}</span></td></tr>`).join('')}
    </table>` : `<div class="empty">No upcoming ARDs yet. Click "Add student" to begin.</div>`}</div>
    <div class="card"><h2>Still needed</h2>
      ${missing.length ? missing.slice(0, 14).map(m => `<div class="miss" data-stu="${esc(m.s.name)}">${esc(m.s.name.split(' ')[0])}: ${esc(m.i.cat)} <span>${esc(m.i.note)}</span></div>`).join('') + (missing.length > 14 ? `<div class="sub">and ${missing.length - 14} more</div>` : '') : '<div class="muted">Nothing missing.</div>'}
      <div class="drop" id="dashDrop">Drop files here, or click to choose.<br>They're sorted into the right student's folder.</div>
    </div>
  </div>`;
  bindCommon(main);
  $('#addStu').onclick = () => studentForm();
  $('#dashDrop').onclick = async () => { const p = await call('files:pick'); if (p.length) sortFiles(p); };
}

function bindCommon(el) {
  $$('[data-go]', el).forEach(b => b.onclick = () => go(b.dataset.go));
  $$('[data-stu]', el).forEach(r => r.onclick = () => go('student/' + encodeURIComponent(r.dataset.stu)));
}

// ---------- student list ----------
async function students(main) {
  const list = await call('students:list');
  main.innerHTML = `<div class="top"><div><h1>Students</h1><div class="sub">${list.length} student${list.length === 1 ? '' : 's'}</div></div>
    <div class="btns"><input type="text" id="q" placeholder="Search" style="width:200px"><button id="openRoot">Open folder</button><button class="p" id="addStu">+ Add student</button></div></div>
    <div class="card"><table id="tbl"><tr><th>Student</th><th>Grade</th><th>Campus</th><th>ARD date</th><th>Readiness</th><th>Drafts</th></tr>
    ${list.map(s => `<tr class="click" data-stu="${esc(s.name)}" data-q="${esc((s.name + ' ' + (s.campus || '')).toLowerCase())}"><td>${esc(s.name)}</td><td>${esc(s.grade || '-')}</td><td>${esc(s.campus || '-')}</td><td>${fmtDate(s.ardDate)}</td>
      <td><span class="bar"><b style="width:${Math.round(100 * s.status.have / Math.max(1, s.status.total))}%;background:${barColor(s.status)}"></b></span><span class="pct">${s.status.have} of ${s.status.total}</span></td><td>${s.drafts.length}</td></tr>`).join('')}
    </table>${list.length ? '' : '<div class="empty">No students yet.</div>'}</div>`;
  bindCommon(main);
  $('#addStu').onclick = () => studentForm();
  $('#openRoot').onclick = () => call('folder:open');
  $('#q').oninput = e => { const q = e.target.value.toLowerCase(); $$('#tbl tr[data-q]').forEach(r => r.style.display = r.dataset.q.includes(q) ? '' : 'none'); };
}

async function studentForm(existing) {
  const s = existing || {};
  const tpls = await call('templates:list');
  modal(`<h2>${existing ? 'Edit student' : 'Add student'}</h2><div class="inner"><div class="form">
    <label class="f full">Full name<input type="text" id="f_name" value="${esc(s.name)}"></label>
    <label class="f">Grade<input type="text" id="f_grade" value="${esc(s.grade)}" placeholder="e.g. 4"></label>
    <label class="f">Campus<input type="text" id="f_campus" value="${esc(s.campus)}"></label>
    <label class="f">ARD date<input type="date" id="f_date" value="${esc(s.ardDate)}"></label>
    <label class="f">Meeting type<select id="f_type">${ARD_TYPES.map(t => `<option ${t === (s.ardType || 'Annual') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f full">Template<select id="f_tpl">${tpls.map(t => `<option value="${esc(t.id)}" ${t.id === (s.templateId || settings.defaultTemplateId) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label class="f full">Notes for the summary (optional)<textarea id="f_notes" placeholder="Anything the AI should know: parent concerns, teacher input, behavior notes...">${esc(s.notes)}</textarea></label>
  </div></div><div class="btns" style="margin-top:14px;justify-content:flex-end"><button id="cancel">Cancel</button><button class="p" id="save">Save</button></div>`);
  $('#f_name').focus();
  $('#cancel').onclick = closeModal;
  $('#save').onclick = async () => {
    const data = { name: $('#f_name').value.trim(), grade: $('#f_grade').value.trim(), campus: $('#f_campus').value.trim(), ardDate: $('#f_date').value, ardType: $('#f_type').value, templateId: $('#f_tpl').value, notes: $('#f_notes').value };
    if (!data.name) return toast('Enter the student\'s name.', true);
    const saved = await call('student:save', data, existing ? existing.name : null);
    closeModal(); toast('Saved.');
    go('student/' + encodeURIComponent(saved.name));
    if (existing) render();
  };
}

// ---------- student page ----------
async function student(main, name) {
  const s = await call('student:get', name);
  if (!s) { main.innerHTML = '<div class="card">Student not found.</div>'; return; }
  if (state.student !== name) { state.student = name; state.tab = 'docs'; state.draftFile = null; state.templateId = null; }
  main.innerHTML = `<div class="top"><div><a data-go="students" class="sub">&larr; Students</a><h1>${esc(s.name)}</h1>
    <div class="sub">Grade ${esc(s.grade || '-')} · ${esc(s.campus || 'campus not set')} · ${esc(s.ardType || 'Annual')} ARD ${fmtDate(s.ardDate)} ${s.status.daysUntil !== null ? '(' + daysCell(s.status.daysUntil) + ')' : ''}</div></div>
    <div class="btns"><button id="edit">Edit details</button><button id="openDir">Open folder</button><button id="addFiles">+ Add files</button></div></div>
  <div class="checklist">${s.status.items.map(i => `<div class="ci"><div class="t">${esc(i.cat)}</div>
    <div class="n ${i.state === 'ok' ? 'ok' : i.state === 'na' ? 'muted' : i.state === 'stale' ? 'warn' : 'bad'}">${i.state === 'ok' ? '✓ ' : ''}${esc(i.note)}</div>
    <label><input type="checkbox" data-na="${esc(i.cat)}" ${i.state === 'na' ? 'checked' : ''}>Not applicable</label></div>`).join('')}</div>
  <div class="tabs"><a data-tab="docs">Documents (${s.files.length})</a><a data-tab="data">Data check${s.status.unconfirmed.length ? ' <span class="chip warn">' + s.status.unconfirmed.length + ' to check</span>' : ''}</a><a data-tab="draft">Draft summary${s.drafts.length ? ' (' + s.drafts.length + ')' : ''}</a></div>
  <div id="tabBody"></div>`;
  bindCommon(main);
  $('#edit').onclick = () => studentForm(s);
  $('#openDir').onclick = () => call('folder:open', s.dir);
  $('#addFiles').onclick = async () => { const p = await call('files:pick'); if (p.length) sortFiles(p, s.name); };
  $$('[data-na]').forEach(c => c.onchange = async () => { await call('student:patch', s.name, { na: { ...(s.na || {}), [c.dataset.na]: c.checked } }); render(); });
  $$('[data-tab]').forEach(a => { a.classList.toggle('on', a.dataset.tab === state.tab); a.onclick = () => { state.tab = a.dataset.tab; render(); }; });
  const body = $('#tabBody');
  if (state.tab === 'docs') docsTab(body, s);
  else if (state.tab === 'data') dataTab(body, s);
  else await draftTab(body, s);
}

function docsTab(el, s) {
  el.innerHTML = `<div class="card">${s.files.length ? `<table class="files"><tr><th>File</th><th>Type</th><th>Date</th><th></th></tr>
    ${s.files.map(f => `<tr><td><a data-open="${esc(f.path)}">${esc(f.name)}</a></td>
      <td><select data-move="${esc(f.rel)}" style="width:150px">${CATS.map(c => `<option ${c === f.category ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
      <td><input type="date" data-date="${esc(f.rel)}" value="${esc(f.date)}" style="width:150px" title="Document date (used to spot stale data)"></td>
      <td><button class="sm ghost" data-reveal="${esc(f.path)}">Show in folder</button></td></tr>`).join('')}</table>
    <div class="sub" style="margin-top:10px">Tip: set each document's real date so stale progress reports and MAP scores get flagged.</div>`
    : '<div class="empty">No files yet. Drop IEPs, FIEs, MAP and STAAR screenshots, and progress reports anywhere in this window.</div>'}</div>`;
  $$('[data-open]', el).forEach(a => a.onclick = () => call('file:open', a.dataset.open));
  $$('[data-reveal]', el).forEach(a => a.onclick = () => call('file:reveal', a.dataset.reveal));
  $$('[data-move]', el).forEach(sel => sel.onchange = async () => { await call('file:move', s.name, sel.dataset.move, sel.value); render(); });
  $$('[data-date]', el).forEach(inp => inp.onchange = async () => { await call('file:setDate', s.name, inp.dataset.date, inp.value); render(); });
}

const SCORE_COLS = {
  map: { title: 'MAP Growth', cat: 'MAP', cols: [['subject', 'Subject'], ['term', 'Term'], ['rit', 'RIT'], ['percentile', 'Percentile'], ['notes', 'Notes (growth, projections)']] },
  staar: { title: 'STAAR', cat: 'STAAR', cols: [['subject', 'Subject'], ['year', 'Year'], ['scaleScore', 'Scale score'], ['performance', 'Performance level'], ['notes', 'Notes']] },
  progress: { title: 'Progress on IEP goals', cat: 'Progress Report', cols: [['goal', 'Goal'], ['status', 'Status'], ['notes', 'Data / comments']] },
};
function dataTab(el, s) {
  const sc = s.scores || {};
  el.innerHTML = `<div class="note">Read the scores from the screenshots and progress report, then fix anything that's off and click Confirm. Confirmed numbers are what the draft uses.</div>
    <div class="btns"><button class="p" id="extract">Read scores from files</button><span class="sub" id="exNote"></span></div>
    ${Object.entries(SCORE_COLS).map(([k, c]) => {
      const rows = (sc[k] && sc[k].rows) || [];
      const na = s.na && s.na[c.cat];
      return `<div class="card" data-k="${k}"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${c.title} ${na ? '<span class="chip">not applicable</span>' : sc[k] && sc[k].confirmed ? '<span class="chip ok">confirmed</span>' : rows.length ? '<span class="chip warn">not confirmed</span>' : ''}</h2>
        <div class="btns"><button class="sm" data-addrow="${k}">+ Row</button><button class="sm p" data-confirm="${k}">Confirm</button></div></div>
        <table class="edit-table" style="margin-top:10px"><tr>${c.cols.map(x => `<th>${x[1]}</th>`).join('')}<th></th></tr>
        ${rows.map((r, i) => `<tr>${c.cols.map(x => `<td><input type="text" data-f="${x[0]}" value="${esc(r[x[0]])}"></td>`).join('')}<td><button class="sm ghost" data-del="${i}">✕</button></td></tr>`).join('')}
        </table>${rows.length ? '' : '<div class="sub" style="padding:8px 4px">No rows yet.</div>'}</div>`;
    }).join('')}`;
  const collect = k => $$(`[data-k="${k}"] tr`, el).slice(1).map(tr => Object.fromEntries($$('input[data-f]', tr).map(i => [i.dataset.f, i.value.trim()]))).filter(r => Object.values(r).some(Boolean));
  $('#extract').onclick = async e => {
    const which = Object.keys(SCORE_COLS).filter(k => !(s.na && s.na[SCORE_COLS[k].cat]) && s.files.some(f => f.category === SCORE_COLS[k].cat));
    if (!which.length) return toast('Add MAP, STAAR, or progress report files first.', true);
    const done = busy(e.target, 'Reading...');
    try {
      const ex = await call('scores:extract', s.name, which);
      for (const k of which) await call('scores:save', s.name, k, ex[k] || [], false);
      toast('Scores read. Check them, then click Confirm on each table.');
      render();
    } catch { done(); }
  };
  $$('[data-confirm]', el).forEach(b => b.onclick = async () => { await call('scores:save', s.name, b.dataset.confirm, collect(b.dataset.confirm), true); toast('Confirmed.'); render(); });
  $$('[data-addrow]', el).forEach(b => b.onclick = async () => {
    const k = b.dataset.addrow; const rows = collect(k); rows.push(Object.fromEntries(SCORE_COLS[k].cols.map(x => [x[0], ''])));
    await call('scores:save', s.name, k, rows, false); render();
  });
  $$('[data-del]', el).forEach(b => b.onclick = async () => {
    const k = b.closest('[data-k]').dataset.k; const rows = collect(k); rows.splice(+b.dataset.del, 1);
    await call('scores:save', s.name, k, rows, false); render();
  });
}

async function draftTab(el, s) {
  const tpls = await call('templates:list');
  const tplId = state.templateId || s.templateId || settings.defaultTemplateId;
  if (!state.draftFile && s.drafts.length) state.draftFile = s.drafts[0].path;
  const html = state.draftFile ? await call('draft:load', state.draftFile) : '';
  const warn = [];
  if (!s.status.ready) warn.push('Some documents are missing; the draft will mark those parts for you to fill in.');
  if (s.status.unconfirmed.length) warn.push('Some scores have not been confirmed in Data check.');
  el.innerHTML = `
    ${warn.length ? `<div class="note warn">${warn.map(esc).join(' ')}</div>` : ''}
    <div class="card"><div class="row" style="flex-wrap:wrap">
      <label class="f" style="width:260px">Template<select id="tpl">${tpls.map(t => `<option value="${esc(t.id)}" ${t.id === tplId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="f" style="flex:1;min-width:240px">Extra instructions for this draft (optional)<input type="text" id="extra" placeholder="e.g. Emphasize growth in reading fluency"></label>
      <button class="p" id="gen" style="align-self:flex-end">${html ? 'Draft again' : 'Draft summary'}</button>
    </div></div>
    ${html ? `<div class="toolbar">
        <select id="pick" style="width:260px">${s.drafts.map(d => `<option value="${esc(d.path)}" ${d.path === state.draftFile ? 'selected' : ''}>${esc(d.name.replace('.html', ''))}</option>`).join('')}</select>
        <button data-cmd="bold"><b>B</b></button><button data-cmd="italic"><i>I</i></button><button data-cmd="insertUnorderedList">• List</button>
        <span class="spacer" style="flex:1"></span>
        <span class="sub" id="saved"></span>
        <button id="save">Save</button><button id="docx">Export Word</button><button id="pdf">Export PDF</button>
      </div>
      <div class="editor" id="editor" contenteditable="true">${highlightPlaceholders(sanitize(html))}</div>
      <div class="card"><div class="row"><input type="text" id="rev" placeholder="Ask for a change, e.g. &quot;Shorten present levels&quot; or &quot;Add a table of MAP scores&quot;"><button class="p" id="revBtn" style="white-space:nowrap">Revise</button></div>
        <div class="sub" style="margin-top:6px">Highlighted [NEEDS INPUT] and [VERIFY] spots are things to fill in or double-check. Revisions reuse the documents already read, so they cost less.</div></div>`
    : '<div class="card empty">No draft yet. Choose a template and click "Draft summary".</div>'}`;
  $('#tpl').onchange = e => { state.templateId = e.target.value; };
  $('#gen').onclick = async e => {
    const done = busy(e.target, 'Drafting... this takes about a minute');
    try {
      const r = await call('draft:generate', s.name, $('#tpl').value, $('#extra').value.trim());
      state.draftFile = r.file; toast(`Draft ready. Cost: ${money(r.cost)}`); render();
    } catch { done(); }
  };
  if (!html) return;
  const ed = $('#editor');
  let dirty = false;
  ed.addEventListener('input', () => { dirty = true; $('#saved').textContent = 'Unsaved changes'; });
  const save = async () => { await call('draft:save', s.name, ed.innerHTML, state.draftFile); dirty = false; $('#saved').textContent = 'Saved'; };
  $('#pick').onchange = e => { state.draftFile = e.target.value; render(); };
  $$('[data-cmd]').forEach(b => b.onclick = () => { document.execCommand(b.dataset.cmd); ed.focus(); });
  $('#save').onclick = save;
  ed.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); } });
  $('#docx').onclick = async () => { if (dirty) await save(); const f = await call('draft:export', s.name, ed.innerHTML, 'docx'); if (f) toast('Saved ' + f); };
  $('#pdf').onclick = async () => { if (dirty) await save(); const f = await call('draft:export', s.name, ed.innerHTML, 'pdf'); if (f) toast('Saved ' + f); };
  $('#revBtn').onclick = async e => {
    const ins = $('#rev').value.trim(); if (!ins) return toast('Type what you want changed.', true);
    const done = busy(e.target, 'Revising...');
    try {
      const r = await call('draft:revise', s.name, $('#tpl').value, ed.innerHTML, ins);
      const file = await call('draft:save', s.name, r.html);
      state.draftFile = file; toast(`Revised and saved as a new version. Cost: ${money(r.cost)}`); render();
    } catch { done(); }
  };
}

// ---------- drag and drop sorting ----------
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map(f => api.pathFor(f)).filter(Boolean);
  if (!paths.length) return;
  const [base, arg] = route.split('/');
  sortFiles(paths, base === 'student' ? decodeURIComponent(arg) : null);
});

async function sortFiles(paths, fixedStudent) {
  modal('<div class="empty"><span class="spin"></span>Looking at the files...</div>');
  let items, list;
  try { [items, list] = await Promise.all([call('files:analyze', paths), call('students:list')]); } catch { return closeModal(); }
  if (fixedStudent) items.forEach(i => i.student = fixedStudent);
  const names = list.map(s => s.name);
  const opts = sel => `<option value="">Choose a student...</option>${names.map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__new">+ New student...</option>`;
  modal(`<h2>Sort ${items.length} file${items.length === 1 ? '' : 's'}</h2><div class="inner">
    <table><tr><th>File</th><th>Student</th><th>Type</th></tr>
    ${items.map((it, i) => `<tr data-i="${i}"><td style="max-width:260px;word-break:break-all">${esc(it.name)}</td>
      <td><select class="stu">${opts(it.student)}</select></td>
      <td><select class="cat">${CATS.map(c => `<option ${c === it.category ? 'selected' : ''}>${c}</option>`).join('')}</select></td></tr>`).join('')}
    </table><div class="sub" style="margin-top:8px">Files are copied into the student's folder. Your originals stay where they are.</div></div>
    <div class="btns" style="margin-top:14px;justify-content:flex-end"><button id="cancel">Cancel</button><button class="p" id="ok">Copy into folders</button></div>`, box => {
    $$('select.stu', box).forEach(sel => sel.onchange = async () => {
      if (sel.value !== '__new') return;
      const n = prompt2('New student full name');
      n.then(async name => {
        if (!name) { sel.value = ''; return; }
        await call('student:save', { name });
        names.push(name);
        $$('select.stu', box).forEach(s2 => { const v = s2 === sel ? name : s2.value; s2.innerHTML = opts(v); });
      });
    });
    $('#cancel').onclick = closeModal;
    $('#ok').onclick = async () => {
      const rows = $$('tr[data-i]', box).map(tr => ({ path: items[+tr.dataset.i].path, student: $('.stu', tr).value, category: $('.cat', tr).value }));
      if (rows.some(r => !r.student || r.student === '__new')) return toast('Choose a student for every file.', true);
      await call('files:import', rows);
      closeModal(); toast(`Copied ${rows.length} file${rows.length === 1 ? '' : 's'}.`); render();
    };
  });
}
// Small inline prompt (window.prompt is not available in Electron).
function prompt2(label) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'card'; wrap.style.marginTop = '12px';
    wrap.innerHTML = `<label class="f">${esc(label)}<input type="text"></label><div class="btns" style="margin-top:8px;justify-content:flex-end"><button class="sm">Cancel</button><button class="sm p">Add</button></div>`;
    $('#modalBox').appendChild(wrap);
    const inp = $('input', wrap); inp.focus();
    const [cancel, ok] = $$('button', wrap);
    const finish = v => { wrap.remove(); resolve(v); };
    cancel.onclick = () => finish(null);
    ok.onclick = () => finish(inp.value.trim() || null);
    inp.onkeydown = e => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') cancel.click(); };
  });
}

// ---------- batch mode ----------
async function batch(main) {
  const list = (await call('students:list')).filter(s => s.status.daysUntil === null || s.status.daysUntil >= 0);
  const tpls = await call('templates:list');
  main.innerHTML = `<div class="top"><div><h1>Batch Mode</h1><div class="sub">Draft several summaries in one go. Each draft is saved to that student's Drafts folder.</div></div></div>
    <div class="card"><div class="row" style="flex-wrap:wrap">
      <label class="f" style="width:260px">Template<select id="tpl"><option value="">Each student's own template</option>${tpls.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
      <div class="btns" style="align-self:flex-end"><button id="selReady">Select ready</button><button id="selNone">Clear</button></div>
      <span class="spacer" style="flex:1"></span>
      <div style="align-self:flex-end" class="sub" id="est"></div>
      <button class="p" id="run" style="align-self:flex-end">Draft selected</button></div></div>
    <div class="card"><table><tr><th></th><th>Student</th><th>ARD date</th><th>Readiness</th><th>Scores</th><th>Status</th></tr>
    ${list.map(s => `<tr><td><input type="checkbox" data-n="${esc(s.name)}" ${s.status.ready ? 'checked' : ''}></td><td><a data-stu="${esc(s.name)}">${esc(s.name)}</a></td><td>${fmtDate(s.ardDate)}</td>
      <td><span class="bar"><b style="width:${Math.round(100 * s.status.have / Math.max(1, s.status.total))}%;background:${barColor(s.status)}"></b></span><span class="pct">${s.status.have} of ${s.status.total}</span></td>
      <td>${s.status.unconfirmed.length ? '<span class="chip warn">not all checked</span>' : s.files.some(f => ['MAP', 'STAAR', 'Progress Report'].includes(f.category)) ? '<span class="chip ok">checked</span>' : '<span class="muted">no score files</span>'}</td>
      <td data-st="${esc(s.name)}">${state.batch[s.name] ? batchCell(state.batch[s.name]) : '<span class="muted">-</span>'}</td></tr>`).join('')}
    </table>${list.length ? '' : '<div class="empty">No upcoming students.</div>'}
    <div class="sub" style="margin-top:10px">Students whose scores aren't checked yet get their screenshots read automatically; those drafts say the scores still need checking.</div></div>`;
  bindCommon(main);
  const est = () => { const n = $$('[data-n]:checked').length; $('#est').textContent = n ? `${n} selected · roughly ${money(n * (settings.model === 'claude-opus-5-5' ? 0.5 : 0.25))} total` : ''; };
  $$('[data-n]').forEach(c => c.onchange = est); est();
  $('#selReady').onclick = () => { $$('[data-n]').forEach(c => c.checked = list.find(s => s.name === c.dataset.n).status.ready); est(); };
  $('#selNone').onclick = () => { $$('[data-n]').forEach(c => c.checked = false); est(); };
  $('#run').onclick = async e => {
    const names = $$('[data-n]:checked').map(c => c.dataset.n);
    if (!names.length) return toast('Select at least one student.', true);
    names.forEach(n => state.batch[n] = { state: 'waiting' });
    names.forEach(n => { const c = $(`[data-st="${CSS.escape(n)}"]`); if (c) c.innerHTML = batchCell(state.batch[n]); });
    const done = busy(e.target, 'Running...');
    try {
      const res = await call('batch:run', names, $('#tpl').value || null);
      const ok = res.filter(r => r.ok);
      toast(`Drafted ${ok.length} of ${res.length}. Total cost ${money(ok.reduce((a, r) => a + r.cost, 0))}.`, ok.length < res.length);
    } finally { done(); }
  };
}
function batchCell(b) {
  if (b.state === 'done') return `<span class="ok">✓ Done</span> <span class="muted">${money(b.cost)}</span>`;
  if (b.state === 'error') return `<span class="bad" title="${esc(b.error)}">Failed: ${esc(b.error.slice(0, 60))}</span>`;
  if (b.state === 'waiting') return '<span class="muted">Waiting</span>';
  return `<span class="spin"></span>${esc(b.state)}`;
}
api.on('batch:progress', m => {
  state.batch[m.name] = m;
  const c = document.querySelector(`[data-st="${CSS.escape(m.name)}"]`);
  if (c) c.innerHTML = batchCell(m);
});

// ---------- templates ----------
async function templates(main) {
  const list = await call('templates:list');
  main.innerHTML = `<div class="top"><div><h1>Templates</h1><div class="sub">Templates set the sections, tone, and format of each summary. Add a past summary you liked as an example and drafts will match it.</div></div>
    <div class="btns"><button class="p" id="new">+ New template</button></div></div>
    ${list.map(t => `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">${esc(t.name)} ${t.id === settings.defaultTemplateId ? '<span class="chip ok">default</span>' : ''}</h2>
      <div class="sub">${t.sections.split('\n').filter(Boolean).length} sections${t.example ? ' · has example summary' : ''}</div></div>
      <div class="btns">${t.id !== settings.defaultTemplateId ? `<button class="sm" data-def="${esc(t.id)}">Make default</button>` : ''}<button class="sm" data-edit="${esc(t.id)}">Edit</button>${t.id !== 'standard' ? `<button class="sm ghost" data-delt="${esc(t.id)}">Delete</button>` : ''}</div></div></div>`).join('')}`;
  $('#new').onclick = () => templateForm({ name: '', sections: list[0].sections, instructions: '', example: '' });
  $$('[data-edit]').forEach(b => b.onclick = () => templateForm(list.find(t => t.id === b.dataset.edit)));
  $$('[data-def]').forEach(b => b.onclick = async () => { settings = { ...settings, ...(await call('settings:save', { defaultTemplateId: b.dataset.def })) }; render(); });
  $$('[data-delt]').forEach(b => b.onclick = async () => {
    modal(`<h2>Delete this template?</h2><div class="btns" style="justify-content:flex-end"><button id="no">Cancel</button><button class="p" id="yes">Delete</button></div>`);
    $('#no').onclick = closeModal;
    $('#yes').onclick = async () => { await call('templates:delete', b.dataset.delt); closeModal(); render(); };
  });
}
function templateForm(t) {
  modal(`<h2>${t.id ? 'Edit template' : 'New template'}</h2><div class="inner"><div class="form">
    <label class="f full">Name<input type="text" id="t_name" value="${esc(t.name)}"></label>
    <label class="f full">Sections, one per line, in order<textarea id="t_sec" style="min-height:170px">${esc(t.sections)}</textarea></label>
    <label class="f full">Style instructions<textarea id="t_ins">${esc(t.instructions)}</textarea></label>
    <label class="f full"><span class="row" style="justify-content:space-between">Example summary you liked (optional) <button class="sm" id="imp">Import from Word or PDF</button></span>
      <textarea id="t_ex" style="min-height:160px" placeholder="Paste a past ARD summary here. Use a fake or redacted one if you prefer.">${esc(t.example)}</textarea></label>
  </div></div><div class="btns" style="margin-top:14px;justify-content:flex-end"><button id="cancel">Cancel</button><button class="p" id="save">Save</button></div>`);
  $('#cancel').onclick = closeModal;
  $('#imp').onclick = async () => { const txt = await call('templates:importExample'); if (txt) $('#t_ex').value = txt; };
  $('#save').onclick = async () => {
    const out = { ...t, name: $('#t_name').value.trim() || 'Untitled template', sections: $('#t_sec').value.trim(), instructions: $('#t_ins').value.trim(), example: $('#t_ex').value.trim(), builtIn: false };
    await call('templates:save', out); closeModal(); toast('Template saved.'); render();
  };
}

// ---------- reminders ----------
async function reminders(main) {
  const list = await call('reminders:list');
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = list.filter(r => r.ardDate >= today);
  main.innerHTML = `<div class="top"><div><h1>Reminders</h1><div class="sub">Windows notifications ${settings.reminderDays.join(' and ')} days before each ARD, listing anything still missing.</div></div>
    <div class="btns"><button id="test">Send a test notification</button><button data-go="settings">Reminder settings</button></div></div>
    ${!settings.runInTray ? '<div class="note warn">Reminders only arrive while ARD Assistant is running. Turn on "Keep running in the background" in Settings so they arrive even after you close the window.</div>' : ''}
    <div class="card"><table><tr><th>Remind on</th><th>Student</th><th>ARD date</th><th>Lead time</th><th>Still needed now</th><th>Status</th></tr>
    ${upcoming.map(r => `<tr class="click" data-stu="${esc(r.student)}"><td>${fmtDate(r.due)}</td><td>${esc(r.student)}</td><td>${fmtDate(r.ardDate)}</td><td>${r.daysBefore} days before</td>
      <td>${r.missing.length ? `<span class="warn">${esc(r.missing.join(', '))}</span>` : '<span class="ok">nothing</span>'}</td><td>${r.sent ? '<span class="chip ok">sent</span>' : '<span class="chip">scheduled</span>'}</td></tr>`).join('')}
    </table>${upcoming.length ? '' : '<div class="empty">Add ARD dates to students to schedule reminders.</div>'}</div>`;
  bindCommon(main);
  $('#test').onclick = () => call('reminders:test');
}

// ---------- costs ----------
const modelName = m => ({ 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' }[m] || m);
async function costs(main) {
  const u = await call('usage:get');
  const month = new Date().toISOString().slice(0, 7);
  const sum = a => a.reduce((x, r) => x + r.cost, 0);
  const thisMonth = u.filter(r => r.ts.startsWith(month));
  const byStudent = {}; for (const r of u) { const k = r.student || '(setup)'; byStudent[k] = (byStudent[k] || 0) + r.cost; }
  const drafts = u.filter(r => r.kind === 'draft');
  const cacheRead = u.reduce((a, r) => a + r.cacheRead, 0);
  main.innerHTML = `<div class="top"><div><h1>Cost Tracker</h1><div class="sub">Estimated from token counts and published API prices. Your Anthropic console shows the exact bill.</div></div>
    <div class="btns"><button id="console">Open Anthropic billing</button></div></div>
    <div class="stats">
      <div class="card stat"><div class="l">This month</div><div class="v">${money(sum(thisMonth))}</div></div>
      <div class="card stat"><div class="l">All time</div><div class="v">${money(sum(u))}</div></div>
      <div class="card stat"><div class="l">Average per draft</div><div class="v">${money(drafts.length ? sum(drafts) / drafts.length : 0)}</div></div>
      <div class="card stat"><div class="l">Tokens reused from cache</div><div class="v">${(cacheRead / 1000).toFixed(0)}k</div></div>
    </div>
    <div class="grid2"><div class="card"><h2>Recent activity</h2><table><tr><th>When</th><th>Student</th><th>What</th><th>Model</th><th>Cost</th></tr>
      ${u.slice(-40).reverse().map(r => `<tr><td>${new Date(r.ts).toLocaleString()}</td><td>${esc(r.student || '-')}</td><td>${esc(r.kind)}</td><td>${esc(modelName(r.model))}</td><td>${money(r.cost)}</td></tr>`).join('')}
      </table>${u.length ? '' : '<div class="empty">No API calls yet.</div>'}</div>
      <div class="card"><h2>By student</h2>${Object.entries(byStudent).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="miss">${esc(k)} <span>${money(v)}</span></div>`).join('') || '<div class="muted">Nothing yet.</div>'}</div></div>`;
  $('#console').onclick = () => window.open('https://console.anthropic.com/settings/billing');
}

// ---------- settings ----------
async function settingsView(main) {
  settings = await call('settings:get');
  main.innerHTML = `<div class="top"><div><h1>Settings</h1><div class="sub">Version ${esc(settings.version)}</div></div></div>
  <div class="card"><h2>Anthropic API key</h2>
    <div class="sub" style="margin-bottom:10px">Create one at <a id="getKey">console.anthropic.com</a> under API Keys. It's stored encrypted with your Windows account and only used to talk to Anthropic.</div>
    <div class="row"><input type="password" id="key" placeholder="${settings.hasKey ? 'A key is saved. Paste a new one to replace it.' : 'sk-ant-...'}"><button class="p" id="saveKey">Save key</button><button id="testKey" ${settings.hasKey ? '' : 'disabled'}>Test</button>${settings.hasKey ? '<button class="ghost" id="clearKey">Remove</button>' : ''}</div>
    <div class="sub" style="margin-top:6px">${settings.hasKey ? '<span class="ok">✓ Key saved</span>' : '<span class="warn">No key saved yet</span>'}</div></div>
  <div class="card"><h2>Model</h2><div class="form">
    <label class="f full">Model used for reading and drafting<select id="model">${Object.entries(settings.models).map(([id, m]) => `<option value="${id}" ${id === settings.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label></div>
    <div class="sub" style="margin-top:6px">Sonnet is a good fit for most summaries. Switch to Opus for long or complicated cases.</div></div>
  <div class="card"><h2>Student files</h2><div class="row"><input type="text" value="${esc(settings.dataRoot)}" readonly><button id="root">Change folder</button><button id="openRoot">Open</button></div>
    <div class="sub" style="margin-top:6px">Each student gets a folder here with IEP, FIE, MAP, STAAR, Progress Report, Other and Drafts subfolders. You can also drop files into those folders yourself.</div></div>
  <div class="card"><h2>Reminders and staleness</h2><div class="form">
    <label class="f">Remind this many days before each ARD (comma separated)<input type="text" id="days" value="${esc(settings.reminderDays.join(', '))}"></label>
    <span></span>
    <label class="f">Flag progress reports older than (days before ARD)<input type="number" id="stP" value="${settings.staleProgressDays}"></label>
    <label class="f">Flag MAP results older than (days before ARD)<input type="number" id="stM" value="${settings.staleMapDays}"></label>
    <label class="row full"><input type="checkbox" id="tray" ${settings.runInTray ? 'checked' : ''}> Keep running in the background (system tray) when the window is closed, so reminders arrive</label>
    <label class="row full"><input type="checkbox" id="login" ${settings.startWithWindows ? 'checked' : ''}> Start ARD Assistant when Windows starts</label>
  </div><div class="btns" style="margin-top:12px"><button class="p" id="saveRem">Save</button></div></div>`;
  $('#getKey').onclick = () => window.open('https://console.anthropic.com/settings/keys');
  $('#saveKey').onclick = async () => { const k = $('#key').value.trim(); if (!k) return toast('Paste your key first.', true); await call('apikey:set', k); toast('Key saved.'); render(); };
  $('#testKey').onclick = async e => { const done = busy(e.target, 'Testing'); try { await call('apikey:test'); toast('The key works.'); } finally { done(); } };
  if ($('#clearKey')) $('#clearKey').onclick = async () => { await call('apikey:set', ''); toast('Key removed.'); render(); };
  $('#model').onchange = async e => { settings = { ...settings, ...(await call('settings:save', { model: e.target.value })) }; toast('Model updated.'); };
  $('#root').onclick = async () => { const r = await call('settings:chooseRoot'); if (r) { toast('Folder changed.'); render(); } };
  $('#openRoot').onclick = () => call('folder:open');
  $('#saveRem').onclick = async () => {
    const days = $('#days').value.split(/[ ,]+/).map(Number).filter(n => n > 0 && n < 120);
    settings = { ...settings, ...(await call('settings:save', { reminderDays: days.length ? days : [14, 3], staleProgressDays: +$('#stP').value || 75, staleMapDays: +$('#stM').value || 150, runInTray: $('#tray').checked, startWithWindows: $('#login').checked })) };
    toast('Saved.'); render();
  };
}

// ---------- boot ----------
(async () => {
  settings = await call('settings:get');
  applyTheme(settings.theme);
  if (!settings.hasKey && !location.hash) location.hash = 'settings';
  render();
})();
