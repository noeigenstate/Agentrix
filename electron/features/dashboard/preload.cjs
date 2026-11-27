const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('agentrixDashboard', {
  summary: query => ipcRenderer.invoke('dashboard:summary', query),
  appearance: () => ipcRenderer.invoke('dashboard:appearance'),
  onAppearance: callback => subscribe('dashboard:appearance-changed', callback),
  onChanged: callback => subscribe('dashboard:changed', () => callback()),
  close: () => ipcRenderer.send('dashboard:close'),
  minimize: () => ipcRenderer.send('dashboard:minimize'),
  maximize: () => ipcRenderer.send('dashboard:maximize'),
});
