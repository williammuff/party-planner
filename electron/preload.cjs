// The only bridge the page gets: native file drag, and the self-updater.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  startDrag: (files) => ipcRenderer.send('start-drag', files),
  updates: {
    status: () => ipcRenderer.invoke('update-status'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
    onStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
  },
});
