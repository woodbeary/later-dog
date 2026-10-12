const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("startupScreen", {
  close: () => ipcRenderer.send("startup-screen:close"),
});
