const path = require("path");
const { app, BrowserWindow, BrowserView, ipcMain } = require("electron");

const TAB_BAR_HEIGHT = 100;

const TABS = [
  { id: "slack", label: "Slack", url: "https://app.slack.com/client", type: "web" },
  { id: "teams", label: "Teams", url: "https://teams.microsoft.com", type: "web" },
  { id: "office", label: "Office", url: "https://www.office.com", type: "web" },
  { id: "gmail", label: "Gmail", url: "https://mail.google.com", type: "web" },
  { id: "calendar", label: "Google Calendar", url: "https://calendar.google.com", type: "web" },
  { id: "settings", label: "Settings", type: "local" }
];

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Map<string, BrowserView>} */
const tabViews = new Map();
let activeTabId = "slack";

/** @type {Map<string, {triggerTab: string, actionType: string, details: string}>} */
const automationRules = new Map();
const automationEvents = [];

function buildTabState(tabId) {
  const view = tabViews.get(tabId);
  if (!view) {
    return { tabId, title: "", url: "", loading: false, canGoBack: false, canGoForward: false };
  }

  const wc = view.webContents;
  return {
    tabId,
    title: wc.getTitle(),
    url: wc.getURL(),
    loading: wc.isLoading(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward()
  };
}

function broadcast(channel, payload) {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function pushAutomationEvent(event) {
  const decorated = {
    ...event,
    createdAt: new Date().toISOString()
  };
  automationEvents.unshift(decorated);
  if (automationEvents.length > 100) {
    automationEvents.length = 100;
  }
  broadcast("automation:event", decorated);
}

function attachViewObservers(tabId, view) {
  const emitState = () => {
    broadcast("tab:state", buildTabState(tabId));
  };
  const wc = view.webContents;
  wc.on("did-start-loading", emitState);
  wc.on("did-stop-loading", emitState);
  wc.on("did-navigate", emitState);
  wc.on("did-navigate-in-page", emitState);
  wc.on("page-title-updated", emitState);

  // Small first-step hook: any desktop notification from a wrapped app is treated
  // as a potential incoming message trigger for automation rule testing.
  wc.on("notification-shown", (_event, notification) => {
    const title = notification.title || "";
    const body = notification.body || "";
    handleMessageTrigger(tabId, { title, body, source: "notification" });
  });
}

function createWebTabView(tab) {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  tabViews.set(tab.id, view);
  attachViewObservers(tab.id, view);
  view.webContents.loadURL(tab.url);
}

function setViewBounds() {
  if (!mainWindow) {
    return;
  }
  const [width, height] = mainWindow.getContentSize();
  for (const view of tabViews.values()) {
    view.setBounds({
      x: 0,
      y: TAB_BAR_HEIGHT,
      width,
      height: Math.max(0, height - TAB_BAR_HEIGHT)
    });
    view.setAutoResize({ width: true, height: true });
  }
}

function switchToTab(tabId) {
  if (!mainWindow) {
    return;
  }
  activeTabId = tabId;
  const selected = TABS.find((tab) => tab.id === tabId);
  if (!selected) {
    return;
  }

  if (selected.type === "local") {
    mainWindow.setBrowserView(null);
    broadcast("tab:active", { tabId, type: "local" });
    return;
  }

  const view = tabViews.get(tabId);
  if (!view) {
    return;
  }
  mainWindow.setBrowserView(view);
  setViewBounds();
  broadcast("tab:active", { tabId, type: "web" });
  broadcast("tab:state", buildTabState(tabId));
}

function handleMessageTrigger(tabId, payload) {
  const matchingRules = Array.from(automationRules.entries()).filter(
    ([, rule]) => rule.triggerTab === tabId
  );

  pushAutomationEvent({
    kind: "trigger",
    tabId,
    payload,
    matchedRules: matchingRules.length
  });

  for (const [ruleId, rule] of matchingRules) {
    pushAutomationEvent({
      kind: "action-planned",
      ruleId,
      tabId,
      actionType: rule.actionType,
      details: rule.details,
      reason: "Incoming message trigger matched tab."
    });
  }
}

function wireIpcHandlers() {
  ipcMain.handle("tabs:list", () => ({ tabs: TABS, activeTabId }));
  ipcMain.handle("tab:switch", (_event, tabId) => {
    switchToTab(tabId);
    return { ok: true };
  });
  ipcMain.handle("tab:get-active-state", () => buildTabState(activeTabId));

  ipcMain.handle("automation:list-rules", () =>
    Array.from(automationRules.entries()).map(([id, rule]) => ({ id, ...rule }))
  );
  ipcMain.handle("automation:add-rule", (_event, payload) => {
    const id = `rule_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    automationRules.set(id, {
      triggerTab: payload.triggerTab,
      actionType: payload.actionType,
      details: payload.details || ""
    });
    return { ok: true, id };
  });
  ipcMain.handle("automation:simulate-message", (_event, payload) => {
    handleMessageTrigger(payload.tabId, {
      title: payload.title || "Simulated message",
      body: payload.body || "",
      source: "simulation"
    });
    return { ok: true };
  });
  ipcMain.handle("automation:recent-events", () => automationEvents);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "CommMeFasterd",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  for (const tab of TABS) {
    if (tab.type === "web") {
      createWebTabView(tab);
    }
  }

  mainWindow.on("resize", setViewBounds);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  switchToTab(activeTabId);
}

app.whenReady().then(() => {
  wireIpcHandlers();
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
