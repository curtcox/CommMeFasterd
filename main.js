const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, BrowserView, ipcMain } = require("electron");

const TAB_BAR_HEIGHT = 100;
const MAX_EVENTS = 400;
const MAX_MESSAGES = 400;
const MAX_EVALUATIONS = 1200;

const TABS = [
  { id: "slack", label: "Slack", url: "https://app.slack.com/client", type: "web" },
  { id: "teams", label: "Teams", url: "https://teams.microsoft.com", type: "web" },
  { id: "office", label: "Office", url: "https://www.office.com", type: "web" },
  { id: "gmail", label: "Gmail", url: "https://mail.google.com", type: "web" },
  { id: "calendar", label: "Google Calendar", url: "https://calendar.google.com", type: "web" },
  { id: "settings", label: "Settings", type: "local" }
];

const DAY_TO_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Map<string, BrowserView>} */
const tabViews = new Map();
let activeTabId = "slack";
let stateFilePath = "";

const automationEvents = [];
const messageHistory = [];
const triggerEvaluations = [];
/** @type {Map<string, any>} */
const actions = new Map();
/** @type {Map<string, any>} */
const triggers = new Map();

let llmSettings = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4.1-mini",
  endpointOverride: ""
};

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function trimArraySize(arr, max) {
  if (arr.length > max) {
    arr.length = max;
  }
}

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
  if (mainWindow) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pushAutomationEvent(event) {
  const decorated = {
    ...event,
    createdAt: nowIso()
  };
  automationEvents.unshift(decorated);
  trimArraySize(automationEvents, MAX_EVENTS);
  broadcast("automation:event", decorated);
  persistState();
}

function parseTimeToken(token) {
  const match = token.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function parseScheduleText(input) {
  const text = (input || "").trim();
  if (!text || /^always$/i.test(text)) {
    return { kind: "always", raw: text || "always", parseable: true };
  }

  const onceMatch = text.match(/^once\s+(.+)$/i);
  if (onceMatch) {
    const date = new Date(onceMatch[1].trim());
    if (!Number.isNaN(date.getTime())) {
      return { kind: "once", raw: text, parseable: true, at: date.toISOString() };
    }
  }

  const dailyMatch = text.match(/^daily\s+(\d{1,2}:\d{2})$/i);
  if (dailyMatch) {
    const tm = parseTimeToken(dailyMatch[1]);
    if (tm) {
      return { kind: "daily", raw: text, parseable: true, hour: tm.hour, minute: tm.minute };
    }
  }

  const weekdaysMatch = text.match(/^weekdays\s+(\d{1,2}:\d{2})$/i);
  if (weekdaysMatch) {
    const tm = parseTimeToken(weekdaysMatch[1]);
    if (tm) {
      return { kind: "weekdays", raw: text, parseable: true, hour: tm.hour, minute: tm.minute };
    }
  }

  const weeklyMatch = text.match(/^weekly\s+([a-z]+)\s+(\d{1,2}:\d{2})$/i);
  if (weeklyMatch) {
    const day = weeklyMatch[1].toLowerCase();
    const tm = parseTimeToken(weeklyMatch[2]);
    if (Object.prototype.hasOwnProperty.call(DAY_TO_INDEX, day) && tm) {
      return {
        kind: "weekly",
        raw: text,
        parseable: true,
        dayOfWeek: DAY_TO_INDEX[day],
        hour: tm.hour,
        minute: tm.minute
      };
    }
  }

  const rangeMatch = text.match(/^between\s+(.+)\s+and\s+(.+)$/i);
  if (rangeMatch) {
    const start = new Date(rangeMatch[1].trim());
    const end = new Date(rangeMatch[2].trim());
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
      return {
        kind: "range",
        raw: text,
        parseable: true,
        start: start.toISOString(),
        end: end.toISOString()
      };
    }
  }

  return {
    kind: "text",
    raw: text,
    parseable: false,
    note:
      "Unparsed schedule text. Supported: always, once <datetime>, daily HH:MM, weekdays HH:MM, weekly <day> HH:MM, between <start> and <end>"
  };
}

function scheduleStatusAt(schedule, atIso) {
  const atDate = new Date(atIso);
  if (!schedule || Number.isNaN(atDate.getTime())) {
    return { active: null, reason: "invalid timestamp" };
  }
  if (schedule.kind === "always") {
    return { active: true, reason: "always active" };
  }
  if (!schedule.parseable) {
    return { active: null, reason: schedule.note || "schedule could not be parsed" };
  }
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    const deltaMs = Math.abs(atDate.getTime() - at.getTime());
    return {
      active: deltaMs <= 60 * 1000,
      reason: `active within 1 minute of ${at.toISOString()}`
    };
  }
  if (schedule.kind === "daily") {
    const active = atDate.getHours() === schedule.hour && atDate.getMinutes() === schedule.minute;
    return { active, reason: `daily ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}` };
  }
  if (schedule.kind === "weekdays") {
    const isWeekday = atDate.getDay() >= 1 && atDate.getDay() <= 5;
    const timeMatch = atDate.getHours() === schedule.hour && atDate.getMinutes() === schedule.minute;
    return {
      active: isWeekday && timeMatch,
      reason: `weekdays ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`
    };
  }
  if (schedule.kind === "weekly") {
    const dayMatch = atDate.getDay() === schedule.dayOfWeek;
    const timeMatch = atDate.getHours() === schedule.hour && atDate.getMinutes() === schedule.minute;
    return {
      active: dayMatch && timeMatch,
      reason: `weekly day=${schedule.dayOfWeek} at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`
    };
  }
  if (schedule.kind === "range") {
    const start = new Date(schedule.start);
    const end = new Date(schedule.end);
    return {
      active: atDate >= start && atDate <= end,
      reason: `between ${start.toISOString()} and ${end.toISOString()}`
    };
  }
  return { active: null, reason: "unknown schedule type" };
}

function evaluateMatchExpression(matchText, payload) {
  const input = `${payload.title || ""}\n${payload.body || ""}`.toLowerCase();
  const text = (matchText || "").trim();
  if (!text) {
    return { matched: true, reason: "empty match expression defaults to true" };
  }

  const regexPrefix = text.match(/^regex:\s*(.+)$/i);
  if (regexPrefix) {
    try {
      const regex = new RegExp(regexPrefix[1], "i");
      const matched = regex.test(`${payload.title || ""}\n${payload.body || ""}`);
      return { matched, reason: `regex ${matched ? "matched" : "did not match"}` };
    } catch (_err) {
      return { matched: false, reason: "invalid regex expression" };
    }
  }

  const slashRegex = text.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashRegex) {
    try {
      const regex = new RegExp(slashRegex[1], slashRegex[2].includes("i") ? slashRegex[2] : `${slashRegex[2]}i`);
      const matched = regex.test(`${payload.title || ""}\n${payload.body || ""}`);
      return { matched, reason: `slash-regex ${matched ? "matched" : "did not match"}` };
    } catch (_err) {
      return { matched: false, reason: "invalid slash-regex expression" };
    }
  }

  const terms = text
    .split(/[\n,]/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);

  if (terms.length === 0) {
    return { matched: true, reason: "empty term list defaults to true" };
  }

  const hit = terms.find((term) => input.includes(term));
  return {
    matched: Boolean(hit),
    reason: hit ? `matched keyword "${hit}"` : "no keyword match"
  };
}

function providerEndpoint(settings) {
  if (settings.endpointOverride) {
    return settings.endpointOverride;
  }
  if (settings.provider === "openai") {
    return "https://api.openai.com/v1/responses";
  }
  if (settings.provider === "anthropic") {
    return "https://api.anthropic.com/v1/messages";
  }
  if (settings.provider === "gemini") {
    return "https://generativelanguage.googleapis.com/v1beta/models";
  }
  return "https://openrouter.ai/api/v1/chat/completions";
}

function baseActionCode(action) {
  const actionKindLiteral = JSON.stringify(action.kind || "custom");
  const instructionsLiteral = JSON.stringify(action.instructions || "");
  const code = [
    `// Action: ${action.name}`,
    `// Kind: ${action.kind}`,
    `// Plain-text instructions: ${action.instructions}`,
    `// Schedule text: ${action.scheduleText || "always"}`,
    "",
    "async function runAction(context) {",
    "  // context includes message payload and trigger metadata",
    "  const { message, trigger } = context;",
    "  const prompt = [",
    `    "Action kind: " + ${actionKindLiteral},`,
    `    "Instructions: " + ${instructionsLiteral},`,
    "    \"Message title: \" + (message.title || \"\"),",
    "    \"Message body: \" + (message.body || \"\")",
    "  ].join(\"\\n\");",
    "",
    "  // Optional: call your configured LLM provider if needed.",
    "  // Replace this with real API calls in your runtime worker.",
    "  return {",
    "    status: 'planned',",
    "    summary: `Will execute ${action.kind} for trigger ${trigger.name}`",
    "  };",
    "}",
    "",
    "module.exports = { runAction };"
  ];
  return code.join("\n");
}

function baseTriggerCode(trigger) {
  const code = [
    `// Trigger: ${trigger.name}`,
    `// Source tab: ${trigger.sourceTab}`,
    `// Match expression (plain text): ${trigger.matchText}`,
    `// Schedule text: ${trigger.scheduleText || "always"}`,
    "",
    "function matchesMessage(message) {",
    "  const matchExpression = " + JSON.stringify(trigger.matchText || "") + ";",
    "  const haystack = `${message.title || ''}\\n${message.body || ''}`.toLowerCase();",
    "  if (!matchExpression.trim()) return true;",
    "  if (matchExpression.startsWith('regex:')) {",
    "    const regex = new RegExp(matchExpression.replace(/^regex:\\s*/i, ''), 'i');",
    "    return regex.test(haystack);",
    "  }",
    "  return matchExpression",
    "    .split(/[\\n,]/)",
    "    .map((x) => x.trim().toLowerCase())",
    "    .filter(Boolean)",
    "    .some((term) => haystack.includes(term));",
    "}",
    "",
    "module.exports = { matchesMessage };"
  ];
  return code.join("\n");
}

async function maybeGenerateWithLlm(kind, sourcePrompt) {
  const provider = llmSettings.provider;
  const apiKey = (llmSettings.apiKey || "").trim();
  if (!apiKey || typeof fetch !== "function") {
    return null;
  }

  try {
    const endpoint = providerEndpoint(llmSettings);
    if (provider === "openai") {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: llmSettings.model || "gpt-4.1-mini",
          input: `Generate only JavaScript code for a ${kind}.\n${sourcePrompt}`
        })
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      const text = Array.isArray(data.output)
        ? data.output
            .flatMap((item) => item.content || [])
            .map((x) => x.text || "")
            .join("\n")
        : "";
      return text.trim() || null;
    }

    if (provider === "anthropic") {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: llmSettings.model || "claude-3-5-sonnet-latest",
          max_tokens: 800,
          messages: [{ role: "user", content: `Generate only JavaScript code for a ${kind}.\n${sourcePrompt}` }]
        })
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      const content = Array.isArray(data.content) ? data.content.map((item) => item.text || "").join("\n") : "";
      return content.trim() || null;
    }

    if (provider === "gemini") {
      const model = llmSettings.model || "gemini-1.5-pro";
      const response = await fetch(`${endpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Generate only JavaScript code for a ${kind}.\n${sourcePrompt}` }] }]
        })
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      const text =
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text;
      return (text || "").trim() || null;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: llmSettings.model || "openai/gpt-4o-mini",
        messages: [{ role: "user", content: `Generate only JavaScript code for a ${kind}.\n${sourcePrompt}` }]
      })
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return (text || "").trim() || null;
  } catch (_err) {
    return null;
  }
}

async function generateActionCode(action, useLlm) {
  const fallback = baseActionCode(action);
  if (!useLlm) {
    return fallback;
  }
  const llmText = await maybeGenerateWithLlm("action", JSON.stringify(action, null, 2));
  return llmText || `${fallback}\n\n// LLM generation unavailable; using fallback template.\n`;
}

async function generateTriggerCode(trigger, useLlm) {
  const fallback = baseTriggerCode(trigger);
  if (!useLlm) {
    return fallback;
  }
  const llmText = await maybeGenerateWithLlm("trigger", JSON.stringify(trigger, null, 2));
  return llmText || `${fallback}\n\n// LLM generation unavailable; using fallback template.\n`;
}

function describeEntitySchedule(entity, atIso) {
  const sched = scheduleStatusAt(entity.schedule, atIso);
  if (!entity.enabled) {
    return { active: false, reason: "disabled" };
  }
  if (sched.active === null) {
    return { active: null, reason: sched.reason };
  }
  return { active: sched.active, reason: sched.reason };
}

function persistState() {
  if (!stateFilePath) {
    return;
  }
  const state = {
    llmSettings,
    actions: Array.from(actions.values()),
    triggers: Array.from(triggers.values()),
    automationEvents,
    messageHistory,
    triggerEvaluations
  };
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf8");
  } catch (_err) {
    // ignore persistence failures in first-step local scaffold
  }
}

function hydrateState() {
  if (!stateFilePath || !fs.existsSync(stateFilePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    if (parsed.llmSettings && typeof parsed.llmSettings === "object") {
      llmSettings = {
        provider: parsed.llmSettings.provider || "openai",
        apiKey: parsed.llmSettings.apiKey || "",
        model: parsed.llmSettings.model || "gpt-4.1-mini",
        endpointOverride: parsed.llmSettings.endpointOverride || ""
      };
    }
    if (Array.isArray(parsed.actions)) {
      parsed.actions.forEach((action) => {
        actions.set(action.id, action);
      });
    }
    if (Array.isArray(parsed.triggers)) {
      parsed.triggers.forEach((trigger) => {
        triggers.set(trigger.id, trigger);
      });
    }
    if (Array.isArray(parsed.automationEvents)) {
      parsed.automationEvents.forEach((event) => automationEvents.push(event));
      trimArraySize(automationEvents, MAX_EVENTS);
    }
    if (Array.isArray(parsed.messageHistory)) {
      parsed.messageHistory.forEach((message) => messageHistory.push(message));
      trimArraySize(messageHistory, MAX_MESSAGES);
    }
    if (Array.isArray(parsed.triggerEvaluations)) {
      parsed.triggerEvaluations.forEach((evaluation) => triggerEvaluations.push(evaluation));
      trimArraySize(triggerEvaluations, MAX_EVALUATIONS);
    }
  } catch (_err) {
    // ignore malformed state file
  }
}

function serializeAction(action) {
  return {
    id: action.id,
    name: action.name,
    kind: action.kind,
    instructions: action.instructions,
    scheduleText: action.scheduleText,
    schedule: action.schedule,
    enabled: action.enabled,
    generatedCode: action.generatedCode,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt
  };
}

function serializeTrigger(trigger) {
  return {
    id: trigger.id,
    name: trigger.name,
    sourceTab: trigger.sourceTab,
    matchText: trigger.matchText,
    scheduleText: trigger.scheduleText,
    schedule: trigger.schedule,
    enabled: trigger.enabled,
    actionIds: trigger.actionIds,
    generatedCode: trigger.generatedCode,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt
  };
}

function listActions() {
  return Array.from(actions.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(serializeAction);
}

function listTriggers() {
  return Array.from(triggers.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(serializeTrigger);
}

function addMessage(tabId, payload) {
  const message = {
    id: newId("msg"),
    tabId,
    title: payload.title || "",
    body: payload.body || "",
    source: payload.source || "unknown",
    createdAt: payload.createdAt || nowIso()
  };
  messageHistory.unshift(message);
  trimArraySize(messageHistory, MAX_MESSAGES);
  return message;
}

function evaluateTriggerOnMessage(trigger, message) {
  if (trigger.sourceTab !== "any" && trigger.sourceTab !== message.tabId) {
    return { matched: false, reason: `source tab mismatch (${trigger.sourceTab} != ${message.tabId})` };
  }
  if (!trigger.enabled) {
    return { matched: false, reason: "trigger disabled" };
  }
  const schedule = scheduleStatusAt(trigger.schedule, message.createdAt);
  if (schedule.active === false) {
    return { matched: false, reason: `trigger schedule inactive (${schedule.reason})` };
  }
  if (schedule.active === null) {
    return { matched: false, reason: `trigger schedule unknown (${schedule.reason})` };
  }
  return evaluateMatchExpression(trigger.matchText, message);
}

function runTriggerPipeline(tabId, payload) {
  const message = addMessage(tabId, payload);
  pushAutomationEvent({
    kind: "message-received",
    tabId,
    messageId: message.id,
    source: message.source,
    title: message.title
  });

  for (const trigger of triggers.values()) {
    const result = evaluateTriggerOnMessage(trigger, message);
    const evaluation = {
      id: newId("eval"),
      triggerId: trigger.id,
      messageId: message.id,
      matched: result.matched,
      reason: result.reason,
      createdAt: nowIso()
    };
    triggerEvaluations.unshift(evaluation);
    trimArraySize(triggerEvaluations, MAX_EVALUATIONS);

    if (!result.matched) {
      continue;
    }

    pushAutomationEvent({
      kind: "trigger-matched",
      triggerId: trigger.id,
      triggerName: trigger.name,
      messageId: message.id,
      messageTitle: message.title
    });

    for (const actionId of trigger.actionIds) {
      const action = actions.get(actionId);
      if (!action) {
        pushAutomationEvent({
          kind: "action-skipped",
          triggerId: trigger.id,
          actionId,
          reason: "action not found"
        });
        continue;
      }
      if (!action.enabled) {
        pushAutomationEvent({
          kind: "action-skipped",
          triggerId: trigger.id,
          actionId: action.id,
          actionName: action.name,
          reason: "action disabled"
        });
        continue;
      }
      const schedule = scheduleStatusAt(action.schedule, message.createdAt);
      if (schedule.active !== true) {
        pushAutomationEvent({
          kind: "action-skipped",
          triggerId: trigger.id,
          actionId: action.id,
          actionName: action.name,
          reason: schedule.active === false ? `schedule inactive (${schedule.reason})` : `schedule unknown (${schedule.reason})`
        });
        continue;
      }

      pushAutomationEvent({
        kind: "action-planned",
        triggerId: trigger.id,
        triggerName: trigger.name,
        actionId: action.id,
        actionName: action.name,
        actionKind: action.kind,
        messageId: message.id,
        reason: "matched trigger and active schedule"
      });
    }
  }

  persistState();
}

function getTriggerApplicationHistory(triggerId) {
  const trigger = triggers.get(triggerId);
  if (!trigger) {
    return [];
  }

  return triggerEvaluations
    .filter((evaluation) => evaluation.triggerId === triggerId)
    .slice(0, 120)
    .map((evaluation) => {
      const message = messageHistory.find((item) => item.id === evaluation.messageId);
      return {
        evaluationId: evaluation.id,
        matched: evaluation.matched,
        reason: evaluation.reason,
        evaluatedAt: evaluation.createdAt,
        message: message || null
      };
    });
}

function inspectSchedule(atIso) {
  const atDate = new Date(atIso);
  if (Number.isNaN(atDate.getTime())) {
    return { ok: false, error: "Invalid timestamp." };
  }

  const triggerStates = listTriggers().map((trigger) => ({
    id: trigger.id,
    name: trigger.name,
    sourceTab: trigger.sourceTab,
    enabled: trigger.enabled,
    scheduleText: trigger.scheduleText,
    state: describeEntitySchedule(trigger, atIso)
  }));

  const actionStates = listActions().map((action) => ({
    id: action.id,
    name: action.name,
    kind: action.kind,
    enabled: action.enabled,
    scheduleText: action.scheduleText,
    state: describeEntitySchedule(action, atIso)
  }));

  return {
    ok: true,
    atIso: atDate.toISOString(),
    triggerStates,
    actionStates
  };
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
  wc.on("notification-shown", (_event, notification) => {
    runTriggerPipeline(tabId, {
      title: notification.title || "",
      body: notification.body || "",
      source: "notification"
    });
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

function wireIpcHandlers() {
  ipcMain.handle("tabs:list", () => ({ tabs: TABS, activeTabId }));
  ipcMain.handle("tab:switch", (_event, tabId) => {
    switchToTab(tabId);
    return { ok: true };
  });
  ipcMain.handle("tab:get-active-state", () => buildTabState(activeTabId));

  ipcMain.handle("automation:get-llm-settings", () => ({
    provider: llmSettings.provider,
    apiKey: llmSettings.apiKey,
    model: llmSettings.model,
    endpointOverride: llmSettings.endpointOverride
  }));
  ipcMain.handle("automation:set-llm-settings", (_event, payload) => {
    llmSettings = {
      provider: payload.provider || "openai",
      apiKey: payload.apiKey || "",
      model: payload.model || "",
      endpointOverride: payload.endpointOverride || ""
    };
    persistState();
    return { ok: true };
  });

  ipcMain.handle("automation:list-actions", () => listActions());
  ipcMain.handle("automation:add-action", async (_event, payload) => {
    const action = {
      id: newId("action"),
      name: payload.name || "Untitled Action",
      kind: payload.kind || "custom",
      instructions: payload.instructions || "",
      scheduleText: payload.scheduleText || "always",
      schedule: parseScheduleText(payload.scheduleText || "always"),
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      generatedCode: ""
    };
    action.generatedCode = await generateActionCode(action, Boolean(payload.useLlmGeneration));
    actions.set(action.id, action);
    persistState();
    return { ok: true, action: serializeAction(action) };
  });
  ipcMain.handle("automation:set-action-enabled", (_event, payload) => {
    const action = actions.get(payload.actionId);
    if (!action) {
      return { ok: false, error: "Action not found." };
    }
    action.enabled = Boolean(payload.enabled);
    action.updatedAt = nowIso();
    actions.set(action.id, action);
    persistState();
    return { ok: true };
  });

  ipcMain.handle("automation:list-triggers", () => listTriggers());
  ipcMain.handle("automation:add-trigger", async (_event, payload) => {
    const trigger = {
      id: newId("trigger"),
      name: payload.name || "Untitled Trigger",
      sourceTab: payload.sourceTab || "any",
      matchText: payload.matchText || "",
      scheduleText: payload.scheduleText || "always",
      schedule: parseScheduleText(payload.scheduleText || "always"),
      actionIds: Array.isArray(payload.actionIds) ? payload.actionIds.filter((x) => actions.has(x)) : [],
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      generatedCode: ""
    };
    trigger.generatedCode = await generateTriggerCode(trigger, Boolean(payload.useLlmGeneration));
    triggers.set(trigger.id, trigger);
    persistState();
    return { ok: true, trigger: serializeTrigger(trigger) };
  });
  ipcMain.handle("automation:set-trigger-enabled", (_event, payload) => {
    const trigger = triggers.get(payload.triggerId);
    if (!trigger) {
      return { ok: false, error: "Trigger not found." };
    }
    trigger.enabled = Boolean(payload.enabled);
    trigger.updatedAt = nowIso();
    triggers.set(trigger.id, trigger);
    persistState();
    return { ok: true };
  });

  ipcMain.handle("automation:simulate-message", (_event, payload) => {
    runTriggerPipeline(payload.tabId || "unknown", {
      title: payload.title || "Simulated message",
      body: payload.body || "",
      source: "simulation",
      createdAt: nowIso()
    });
    return { ok: true };
  });

  ipcMain.handle("automation:recent-events", () => automationEvents.slice(0, 200));
  ipcMain.handle("automation:list-messages", () => messageHistory.slice(0, 200));
  ipcMain.handle("automation:trigger-history", (_event, payload) => getTriggerApplicationHistory(payload.triggerId));
  ipcMain.handle("automation:inspect-schedule", (_event, payload) => inspectSchedule(payload.atIso));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
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
  stateFilePath = path.join(app.getPath("userData"), "automation-state.json");
  hydrateState();
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
