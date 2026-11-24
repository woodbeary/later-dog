const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("presence", {
  onState: callback => { ipcRenderer.on("presence:state", (_event, state) => callback(state)); },
  hover: inside => ipcRenderer.send("presence:hover", inside === true),
  stop: () => ipcRenderer.send("presence:stop"),
});
