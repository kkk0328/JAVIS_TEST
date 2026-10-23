const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  log: (...a) => ipcRenderer.send('log', a.map(String).join(' ')),
  getConfig: () => ipcRenderer.invoke('jarvis:config'),
  sttStatus: () => ipcRenderer.invoke('stt:status'),
  transcribe: (pcm) => ipcRenderer.invoke('stt:transcribe', pcm),
  runClaude: (text) => ipcRenderer.send('claude:run', text),
  cancelClaude: () => ipcRenderer.send('claude:cancel'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  onSttStatus: (cb) => ipcRenderer.on('stt:status', (_e, s) => cb(s)),
  onClaudeEvent: (cb) => ipcRenderer.on('claude:event', (_e, ev) => cb(ev)),
  onWake: (cb) => ipcRenderer.on('jarvis:wake', () => cb()),
});
