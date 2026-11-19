const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(ch, ...args) {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

contextBridge.exposeInMainWorld('api', {
  call,
  pathFor: (file) => webUtils.getPathForFile(file),
  on: (ch, fn) => {
    if (!['batch:progress', 'navigate'].includes(ch)) return;
    ipcRenderer.on(ch, (_e, msg) => fn(msg));
  },
});
