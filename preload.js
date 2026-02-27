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
    getLlmSettings: () => ipcRenderer.invoke("automation:get-llm-settings"),
    setLlmSettings: (payload) => ipcRenderer.invoke("automation:set-llm-settings", payload),
    listActions: () => ipcRenderer.invoke("automation:list-actions"),
    addAction: (payload) => ipcRenderer.invoke("automation:add-action", payload),
    setActionEnabled: (payload) => ipcRenderer.invoke("automation:set-action-enabled", payload),
    listTriggers: () => ipcRenderer.invoke("automation:list-triggers"),
    addTrigger: (payload) => ipcRenderer.invoke("automation:add-trigger", payload),
    setTriggerEnabled: (payload) => ipcRenderer.invoke("automation:set-trigger-enabled", payload),
    simulateMessage: (payload) => ipcRenderer.invoke("automation:simulate-message", payload),
    getRecentEvents: () => ipcRenderer.invoke("automation:recent-events"),
    listMessages: () => ipcRenderer.invoke("automation:list-messages"),
    getTriggerHistory: (payload) => ipcRenderer.invoke("automation:trigger-history", payload),
    inspectSchedule: (payload) => ipcRenderer.invoke("automation:inspect-schedule", payload),
    onEvent: (handler) => ipcRenderer.on("automation:event", (_event, payload) => handler(payload))
  },
  database: {
    getOverview: () => ipcRenderer.invoke("database:overview"),
    query: (payload) => ipcRenderer.invoke("database:query", payload)
  }
});
