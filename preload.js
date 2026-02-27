const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commMeFasterd", {
  tabs: {
    list: () => ipcRenderer.invoke("tabs:list"),
    switchTo: (tabId) => ipcRenderer.invoke("tab:switch", tabId),
    getActiveState: () => ipcRenderer.invoke("tab:get-active-state"),
    onActiveChange: (handler) => ipcRenderer.on("tab:active", (_event, payload) => handler(payload)),
    onStateChange: (handler) => ipcRenderer.on("tab:state", (_event, payload) => handler(payload))
  },
  automation: {
    listRules: () => ipcRenderer.invoke("automation:list-rules"),
    addRule: (rule) => ipcRenderer.invoke("automation:add-rule", rule),
    simulateMessage: (payload) => ipcRenderer.invoke("automation:simulate-message", payload),
    getRecentEvents: () => ipcRenderer.invoke("automation:recent-events"),
    onEvent: (handler) => ipcRenderer.on("automation:event", (_event, payload) => handler(payload))
  }
});
