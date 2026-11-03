const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('agentrixLab', {
  list: () => ipcRenderer.invoke('lab:list'),
  projects: () => ipcRenderer.invoke('lab:projects'),
  sources: () => ipcRenderer.invoke('lab:sources'),
  aaKey: value => ipcRenderer.invoke('lab:aa-key', value),
  sample: request => ipcRenderer.invoke('lab:sample', request),
  estimate: input => ipcRenderer.invoke('lab:estimate', input),
  start: input => ipcRenderer.invoke('lab:start', input),
  stop: id => ipcRenderer.invoke('lab:stop', id),
  remove: id => ipcRenderer.invoke('lab:remove', id),
  appearance: () => ipcRenderer.invoke('lab:appearance'),
  onAppearance: callback => subscribe('lab:appearance-changed', callback),
  onChange: callback => subscribe('lab:changed', callback),
  close: () => ipcRenderer.send('lab:close'),
  minimize: () => ipcRenderer.send('lab:minimize'),
  maximize: () => ipcRenderer.send('lab:maximize'),
});
