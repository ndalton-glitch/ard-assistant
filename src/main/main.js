const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const docs = require('./docs');
const ai = require('./ai');
const exporter = require('./exporter');

let win = null, tray = null, quitting = false;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setAppUserModelId('local.ardassistant.app');

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 640,
    backgroundColor: store.getSettings().theme === 'light' ? '#eef7fd' : '#0b0506',
    title: 'ARD Assistant', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', e => {
    if (!quitting && store.getSettings().runInTray) { e.preventDefault(); win.hide(); }
  });
}
function showWindow(route) {
  if (!win || win.isDestroyed()) createWindow();
  win.show(); win.focus();
  if (route) win.webContents.send('navigate', route);
}

function setupTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('ARD Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ARD Assistant', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
}

// ---------- reminders ----------
function reminderList() {
  const s = store.getSettings();
  const days = [...s.reminderDays].sort((a, b) => b - a);
  const out = [];
  for (const st of store.listStudents()) {
    if (!st.ardDate) continue;
    for (const d of days) {
      const key = `${st.name}|${st.ardDate}|${d}`;
      const due = new Date(st.ardDate + 'T08:00:00'); due.setDate(due.getDate() - d);
      out.push({ student: st.name, ardDate: st.ardDate, daysBefore: d, due: due.toISOString().slice(0, 10), sent: !!s.notified[key], key,
        missing: st.status.items.filter(i => i.state === 'missing' || i.state === 'stale').map(i => i.cat) });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
function checkReminders() {
  const s = store.getSettings();
  const notified = { ...s.notified };
  const todayStr = store.today();
  const byStudent = {};
  for (const r of reminderList()) {
    if (r.sent || r.due > todayStr || r.ardDate < todayStr) continue;
    notified[r.key] = new Date().toISOString();
    (byStudent[r.student] = byStudent[r.student] || []).push(r);
  }
  for (const [name, rs] of Object.entries(byStudent)) {
    const r = rs[0];
    const left = store.daysBetween(todayStr, r.ardDate);
    const body = (left === 0 ? 'ARD is today.' : `ARD in ${left} day${left === 1 ? '' : 's'} (${r.ardDate}).`) +
      (r.missing.length ? ` Still needed: ${r.missing.join(', ')}.` : ' All documents are in.');
    if (Notification.isSupported()) {
      const n = new Notification({ title: `ARD reminder: ${name}`, body, icon: ICON });
      n.on('click', () => showWindow('student/' + encodeURIComponent(name)));
      n.show();
    }
  }
  if (Object.keys(byStudent).length) store.saveSettings({ notified });
}

// ---------- IPC ----------
const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) { console.error(ch, e); return { ok: false, error: e.message || String(e) }; }
});

h('settings:get', () => ({ ...store.getSettings(), hasKey: !!store.getApiKey(), models: store.MODELS, version: app.getVersion() }));
h('settings:save', patch => {
  const s = store.saveSettings(patch);
  if ('startWithWindows' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.startWithWindows, args: ['--hidden'] });
  if (s.runInTray) setupTray(); else if (tray) { tray.destroy(); tray = null; }
  return s;
});
h('settings:chooseRoot', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder for student files', properties: ['openDirectory', 'createDirectory'], defaultPath: store.getSettings().dataRoot });
  if (r.canceled || !r.filePaths[0]) return null;
  return store.saveSettings({ dataRoot: r.filePaths[0] }).dataRoot;
});
h('apikey:set', key => { store.setApiKey(key); return !!store.getApiKey(); });
h('apikey:test', () => ai.testKey());

h('students:list', () => store.listStudents());
h('student:get', name => store.loadStudent(name));
h('student:save', (data, original) => { const r = store.saveStudent(data, original); setTimeout(checkReminders, 1000); return r; });
h('student:patch', (name, patch) => store.patchStudent(name, patch));

h('files:analyze', paths => docs.analyzeDrop(paths.filter(p => fs.existsSync(p) && fs.statSync(p).isFile())));
h('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents and screenshots', extensions: ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt'] }] });
  return r.canceled ? [] : r.filePaths;
});
h('files:import', items => items.map(it => docs.importFile(it.path, it.student, it.category)));
h('file:open', p => shell.openPath(p));
h('file:reveal', p => shell.showItemInFolder(p));
h('file:setDate', (name, rel, date) => {
  const st = store.loadStudent(name);
  return store.patchStudent(name, { docDates: { ...(st.docDates || {}), [rel]: date } });
});
h('file:move', (name, rel, cat) => {
  const dir = store.studentDir(name);
  const from = path.join(dir, rel);
  if (!fs.existsSync(from) || !store.CATEGORIES.includes(cat)) throw new Error('Cannot move that file.');
  const to = path.join(dir, cat, path.basename(rel));
  if (fs.existsSync(to)) throw new Error('A file with that name is already in ' + cat + '.');
  fs.renameSync(from, to);
  return store.loadStudent(name);
});
h('folder:open', p => shell.openPath(p || store.root()));

h('scores:extract', async (name, which) => ai.extractScores(store.loadStudent(name), which));
h('scores:save', (name, key, rows, confirmed) => {
  const st = store.loadStudent(name);
  return store.patchStudent(name, { scores: { ...(st.scores || {}), [key]: { rows, confirmed: !!confirmed, at: new Date().toISOString() } } });
});

function mdToHtml(md) { const { marked } = require('marked'); return marked.parse(md || '', { gfm: true }); }
h('draft:generate', async (name, templateId, extra) => {
  const st = store.loadStudent(name);
  const r = await ai.draft(st, store.getTemplate(templateId || st.templateId), extra);
  const html = mdToHtml(r.text);
  const file = saveDraft(name, html);
  return { html, cost: r.cost, file };
});
h('draft:revise', async (name, templateId, currentHtml, instruction) => {
  const st = store.loadStudent(name);
  const r = await ai.revise(st, store.getTemplate(templateId || st.templateId), currentHtml, instruction);
  return { html: mdToHtml(r.text), cost: r.cost };
});
function saveDraft(name, html, file) {
  const dir = path.join(store.studentDir(name), 'Drafts');
  fs.mkdirSync(dir, { recursive: true });
  if (!file) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
    file = path.join(dir, `ARD Summary ${stamp}.html`);
  }
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new Error('Drafts can only be saved in the student\'s Drafts folder.');
  fs.writeFileSync(file, html);
  return file;
}
h('draft:save', (name, html, file) => saveDraft(name, html, file));
h('draft:load', file => fs.readFileSync(file, 'utf8'));
h('draft:export', async (name, html, kind) => {
  const st = store.loadStudent(name);
  const base = `${st.name} ARD Summary ${st.ardDate || store.today()}`;
  const r = await dialog.showSaveDialog(win, {
    title: kind === 'pdf' ? 'Save as PDF' : 'Save as Word',
    defaultPath: path.join(st.dir, 'Drafts', base + (kind === 'pdf' ? '.pdf' : '.docx')),
    filters: kind === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Word document', extensions: ['docx'] }],
  });
  if (r.canceled || !r.filePath) return null;
  if (kind === 'pdf') await exporter.toPdf(html, r.filePath, base); else await exporter.toDocx(html, r.filePath);
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

h('templates:list', () => store.listTemplates());
h('templates:save', t => store.saveTemplate(t));
h('templates:delete', id => store.deleteTemplate(id));
h('templates:importExample', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a past ARD summary', properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['docx', 'pdf', 'txt'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const text = await docs.localText(r.filePaths[0]);
  if (!text) throw new Error('No text could be read from that file. If it is a scan, paste the text instead.');
  return text;
});

h('usage:get', () => store.getUsage());
h('reminders:list', () => reminderList());
h('reminders:test', () => {
  new Notification({ title: 'ARD Assistant', body: 'Reminders are working. You will see notices like this before each ARD.', icon: ICON }).show();
  return true;
});

let batchRunning = false;
h('batch:run', async (names, templateId) => {
  if (batchRunning) throw new Error('A batch is already running.');
  batchRunning = true;
  const results = [];
  const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('batch:progress', msg); };
  try {
    for (const name of names) {
      try {
        let st = store.loadStudent(name);
        // Read any unconfirmed screenshots first so the draft has numbers to work with.
        const need = st.status.unconfirmed.filter(k => !(st.scores && st.scores[k] && st.scores[k].rows && st.scores[k].rows.length));
        if (need.length) {
          send({ name, state: 'reading scores' });
          const ex = await ai.extractScores(st, need);
          const scores = { ...(st.scores || {}) };
          for (const k of need) scores[k] = { rows: ex[k] || [], confirmed: false, at: new Date().toISOString() };
          st = store.patchStudent(name, { scores });
        }
        send({ name, state: 'drafting' });
        const r = await ai.draft(st, store.getTemplate(templateId || st.templateId));
        const file = saveDraft(name, mdToHtml(r.text));
        results.push({ name, ok: true, file, cost: r.cost });
        send({ name, state: 'done', cost: r.cost, file });
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
        send({ name, state: 'error', error: e.message });
      }
    }
  } finally { batchRunning = false; }
  return results;
});

// ---------- lifecycle ----------
// Windows only shows notifications for apps whose Start Menu shortcut carries the app's ID.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ARD Assistant');
    fs.mkdirSync(dir, { recursive: true });
    const lnk = path.join(dir, 'ARD Assistant.lnk');
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', { target: process.execPath, appUserModelId: 'local.ardassistant.app', icon: process.execPath, iconIndex: 0 });
  } catch (e) { console.error('shortcut', e); }
}

app.whenReady().then(() => {
  ensureStartMenuShortcut();
  const hidden = process.argv.includes('--hidden');
  if (store.getSettings().runInTray) setupTray();
  if (!hidden) createWindow();
  setTimeout(checkReminders, 5000);
  setInterval(checkReminders, 30 * 60 * 1000);
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!store.getSettings().runInTray) app.quit(); });
app.on('activate', () => showWindow());
