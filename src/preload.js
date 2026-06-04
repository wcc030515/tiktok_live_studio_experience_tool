const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inspector", {
  detectEnv: () => ipcRenderer.invoke("env:detect"),
  listRoles: () => ipcRenderer.invoke("roles:list"),
  openRolesDir: () => ipcRenderer.invoke("roles:openDir"),
  startTask: (config) => ipcRenderer.invoke("task:start", config),
  stopTask: () => ipcRenderer.invoke("task:stop"),
  humanDone: () => ipcRenderer.invoke("task:humanDone"),
  imageDataUrl: (filePath) => ipcRenderer.invoke("image:dataUrl", filePath),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  openDir: (dirPath) => ipcRenderer.invoke("dir:open", dirPath),
  onEnvUpdate: (callback) => ipcRenderer.on("env:update", (_event, payload) => callback(payload)),
  onTaskStarted: (callback) => ipcRenderer.on("task:started", (_event, payload) => callback(payload)),
  onTaskLog: (callback) => ipcRenderer.on("task:log", (_event, payload) => callback(payload)),
  onTaskFinished: (callback) => ipcRenderer.on("task:finished", (_event, payload) => callback(payload)),
  onTaskError: (callback) => ipcRenderer.on("task:error", (_event, payload) => callback(payload))
});
