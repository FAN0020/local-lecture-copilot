const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  chooseWorkspace: () => ipcRenderer.invoke('choose-workspace'),
});
