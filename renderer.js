const appApi = window.commMeFasterd;

const el = {
  tabs: document.getElementById("tabs"),
  settingsPanel: document.getElementById("settings-panel"),
  databasePanel: document.getElementById("database-panel"),
  activeViewState: document.getElementById("active-view-state"),

  llmForm: document.getElementById("llm-form"),
  llmProvider: document.getElementById("llm-provider"),
  llmModel: document.getElementById("llm-model"),
  llmEndpoint: document.getElementById("llm-endpoint"),
  llmApiKey: document.getElementById("llm-api-key"),

  actionForm: document.getElementById("action-form"),
  actionName: document.getElementById("action-name"),
  actionKind: document.getElementById("action-kind"),
  actionInstructions: document.getElementById("action-instructions"),
  actionSchedule: document.getElementById("action-schedule"),
  actionUseLlm: document.getElementById("action-use-llm"),
  actionsList: document.getElementById("actions-list"),

  triggerForm: document.getElementById("trigger-form"),
  triggerName: document.getElementById("trigger-name"),
  triggerSourceTab: document.getElementById("trigger-source-tab"),
  triggerMatchText: document.getElementById("trigger-match-text"),
  triggerSchedule: document.getElementById("trigger-schedule"),
  triggerActionPicker: document.getElementById("trigger-action-picker"),
  triggerUseLlm: document.getElementById("trigger-use-llm"),
  triggersList: document.getElementById("triggers-list"),

  simulateForm: document.getElementById("simulate-form"),
  simulateTab: document.getElementById("simulate-tab"),
  simulateTitle: document.getElementById("simulate-title"),
  simulateBody: document.getElementById("simulate-body"),

  historyTriggerSelect: document.getElementById("history-trigger-select"),
  triggerHistoryList: document.getElementById("trigger-history-list"),

  scheduleInspectForm: document.getElementById("schedule-inspect-form"),
  scheduleInspectAt: document.getElementById("schedule-inspect-at"),
  scheduleInspectionList: document.getElementById("schedule-inspection-list"),

  eventsList: document.getElementById("events-list"),

  dbPath: document.getElementById("db-path"),
  dbRefresh: document.getElementById("db-refresh"),
  dbCountsList: document.getElementById("db-counts-list"),
  dbRecentEvents: document.getElementById("db-recent-events"),
  dbRecentMessages: document.getElementById("db-recent-messages"),
  dbQueryForm: document.getElementById("db-query-form"),
  dbSql: document.getElementById("db-sql"),
  dbQueryResult: document.getElementById("db-query-result"),
  dbConsoleLogs: document.getElementById("db-console-logs"),
  dbHttpTraffic: document.getElementById("db-http-traffic"),
  dbScreenshots: document.getElementById("db-screenshots"),

  diagScreenshotForm: document.getElementById("diag-screenshot-form"),
  diagScreenshotTab: document.getElementById("diag-screenshot-tab"),
  diagScreenshotMeta: document.getElementById("diag-screenshot-meta"),
  diagScreenshotPreview: document.getElementById("diag-screenshot-preview")
};

let currentActiveTab = "";
let actionCache = [];
let triggerCache = [];

function tabButtonClass(tabId) {
  return tabId === currentActiveTab ? "tab-button is-active" : "tab-button";
}

function setDefaultInspectionTime() {
  if (el.scheduleInspectAt.value) {
    return;
  }
  const now = new Date();
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  el.scheduleInspectAt.value = localIso;
}

async function renderTabStrip() {
  const data = await appApi.tabs.list();
  currentActiveTab = data.activeTabId;
  el.tabs.innerHTML = "";

  data.tabs.forEach((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = tabButtonClass(tab.id);
    button.textContent = tab.label;
    button.addEventListener("click", async () => {
      await appApi.tabs.switchTo(tab.id);
    });
    el.tabs.appendChild(button);
  });

  const sourceTabOptions = [{ id: "any", label: "Any source" }].concat(
    data.tabs.filter((tab) => tab.type === "web").map((tab) => ({ id: tab.id, label: tab.label }))
  );
  populateSelect(el.triggerSourceTab, sourceTabOptions);
  populateSelect(
    el.simulateTab,
    data.tabs.filter((tab) => tab.type === "web").map((tab) => ({ id: tab.id, label: tab.label }))
  );
  populateSelect(
    el.diagScreenshotTab,
    [{ id: "__active__", label: "Active web tab" }].concat(
      data.tabs.filter((tab) => tab.type === "web").map((tab) => ({ id: tab.id, label: tab.label }))
    )
  );
  updateLocalPanelsVisibility();
}

function populateSelect(select, values) {
  select.innerHTML = "";
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value.id;
    option.textContent = value.label;
    select.appendChild(option);
  });
}

function updateLocalPanelsVisibility() {
  el.settingsPanel.classList.toggle("hidden", currentActiveTab !== "settings");
  el.databasePanel.classList.toggle("hidden", currentActiveTab !== "database");
}

function renderActiveState(state) {
  if (!state || currentActiveTab === "settings" || currentActiveTab === "database") {
    el.activeViewState.textContent = `${currentActiveTab || "local"} tab is local.`;
    return;
  }
  el.activeViewState.textContent = [
    `${state.tabId}`,
    `${state.loading ? "loading" : "idle"}`,
    `${state.title || "(no title)"}`,
    `${state.url || "(no url yet)"}`,
    `back:${state.canGoBack ? "y" : "n"}`,
    `forward:${state.canGoForward ? "y" : "n"}`
  ].join(" | ");
}

function formatScheduleStatus(state) {
  if (state.active === true) {
    return `active (${state.reason})`;
  }
  if (state.active === false) {
    return `inactive (${state.reason})`;
  }
  return `unknown (${state.reason})`;
}

function createCodeDetails(label, code) {
  const details = document.createElement("details");
  details.className = "code-details";
  const summary = document.createElement("summary");
  summary.textContent = `Inspect generated ${label} code`;
  const pre = document.createElement("pre");
  pre.className = "code-block";
  pre.textContent = code || "// No code generated";
  details.appendChild(summary);
  details.appendChild(pre);
  return details;
}

function selectedActionIds() {
  const checked = el.triggerActionPicker.querySelectorAll('input[type="checkbox"]:checked');
  return Array.from(checked).map((node) => node.value);
}

function renderActionPicker() {
  el.triggerActionPicker.innerHTML = "";
  const legend = document.createElement("legend");
  legend.textContent = "Actions to run when trigger matches";
  el.triggerActionPicker.appendChild(legend);

  if (actionCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "picker-empty";
    empty.textContent = "Add actions first, then select them here.";
    el.triggerActionPicker.appendChild(empty);
    return;
  }

  actionCache.forEach((action) => {
    const row = document.createElement("label");
    row.className = "inline-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = action.id;
    if (!action.enabled) {
      input.disabled = true;
    }
    const text = document.createElement("span");
    text.textContent = `${action.name} (${action.kind})${action.enabled ? "" : " [disabled]"}`;
    row.appendChild(input);
    row.appendChild(text);
    el.triggerActionPicker.appendChild(row);
  });
}

async function renderLlmSettings() {
  const settings = await appApi.automation.getLlmSettings();
  el.llmProvider.value = settings.provider || "openai";
  el.llmModel.value = settings.model || "";
  el.llmEndpoint.value = settings.endpointOverride || "";
  el.llmApiKey.value = settings.apiKey || "";
}

async function renderActions() {
  actionCache = await appApi.automation.listActions();
  el.actionsList.innerHTML = "";
  if (actionCache.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No actions yet.";
    el.actionsList.appendChild(empty);
    renderActionPicker();
    return;
  }

  actionCache.forEach((action) => {
    const item = document.createElement("li");
    item.className = "entity-item";

    const topRow = document.createElement("div");
    topRow.className = "entity-top";

    const title = document.createElement("strong");
    title.textContent = `${action.name} (${action.kind})`;

    const enabledWrap = document.createElement("label");
    enabledWrap.className = "inline-check";
    const enabledBox = document.createElement("input");
    enabledBox.type = "checkbox";
    enabledBox.checked = Boolean(action.enabled);
    enabledBox.addEventListener("change", async () => {
      await appApi.automation.setActionEnabled({ actionId: action.id, enabled: enabledBox.checked });
      await renderActions();
      await renderTriggers();
      await renderScheduleInspection();
    });
    const enabledText = document.createElement("span");
    enabledText.textContent = "enabled";
    enabledWrap.appendChild(enabledBox);
    enabledWrap.appendChild(enabledText);

    topRow.appendChild(title);
    topRow.appendChild(enabledWrap);
    item.appendChild(topRow);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `schedule="${action.scheduleText}" | updated=${action.updatedAt}`;
    item.appendChild(meta);

    const instructions = document.createElement("div");
    instructions.className = "meta";
    instructions.textContent = `instructions: ${action.instructions}`;
    item.appendChild(instructions);

    item.appendChild(createCodeDetails("action", action.generatedCode));
    el.actionsList.appendChild(item);
  });

  renderActionPicker();
}

async function renderTriggers() {
  triggerCache = await appApi.automation.listTriggers();
  el.triggersList.innerHTML = "";
  if (triggerCache.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No triggers yet.";
    el.triggersList.appendChild(empty);
    renderTriggerHistoryOptions();
    return;
  }

  triggerCache.forEach((trigger) => {
    const item = document.createElement("li");
    item.className = "entity-item";

    const topRow = document.createElement("div");
    topRow.className = "entity-top";

    const title = document.createElement("strong");
    title.textContent = `${trigger.name} [${trigger.sourceTab}]`;

    const enabledWrap = document.createElement("label");
    enabledWrap.className = "inline-check";
    const enabledBox = document.createElement("input");
    enabledBox.type = "checkbox";
    enabledBox.checked = Boolean(trigger.enabled);
    enabledBox.addEventListener("change", async () => {
      await appApi.automation.setTriggerEnabled({ triggerId: trigger.id, enabled: enabledBox.checked });
      await renderTriggers();
      await renderScheduleInspection();
    });
    const enabledText = document.createElement("span");
    enabledText.textContent = "enabled";
    enabledWrap.appendChild(enabledBox);
    enabledWrap.appendChild(enabledText);

    topRow.appendChild(title);
    topRow.appendChild(enabledWrap);
    item.appendChild(topRow);

    const linkedActions = trigger.actionIds
      .map((id) => actionCache.find((action) => action.id === id))
      .filter(Boolean)
      .map((action) => action.name)
      .join(", ");

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `match="${trigger.matchText || "(empty)"}" | schedule="${trigger.scheduleText}" | actions=[${linkedActions || "none"}]`;
    item.appendChild(meta);
    item.appendChild(createCodeDetails("trigger", trigger.generatedCode));
    el.triggersList.appendChild(item);
  });

  renderTriggerHistoryOptions();
}

function renderEvents(events) {
  el.eventsList.innerHTML = "";
  events.slice(0, 50).forEach((event) => appendEvent(event));
}

function appendEvent(event) {
  const item = document.createElement("li");
  item.className = "event-item";
  const core = `[${event.createdAt}] ${event.kind}`;
  const details = event.reason
    ? event.reason
    : JSON.stringify({
        trigger: event.triggerName || event.triggerId || null,
        action: event.actionName || event.actionId || null,
        title: event.messageTitle || event.title || null
      });
  item.textContent = `${core} - ${details}`;
  el.eventsList.prepend(item);
  while (el.eventsList.children.length > 100) {
    el.eventsList.removeChild(el.eventsList.lastChild);
  }
}

function renderTriggerHistoryOptions() {
  el.historyTriggerSelect.innerHTML = "";
  if (triggerCache.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No triggers available";
    el.historyTriggerSelect.appendChild(option);
    el.triggerHistoryList.innerHTML = "";
    return;
  }

  triggerCache.forEach((trigger) => {
    const option = document.createElement("option");
    option.value = trigger.id;
    option.textContent = trigger.name;
    el.historyTriggerSelect.appendChild(option);
  });
}

async function renderTriggerHistory() {
  const triggerId = el.historyTriggerSelect.value;
  el.triggerHistoryList.innerHTML = "";
  if (!triggerId) {
    return;
  }
  const rows = await appApi.automation.getTriggerHistory({ triggerId });
  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No evaluations for this trigger yet.";
    el.triggerHistoryList.appendChild(empty);
    return;
  }

  rows.forEach((row) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    const messageText = row.message
      ? `[${row.message.createdAt}] ${row.message.tabId} | ${row.message.title} | ${row.message.body}`
      : "Message no longer available";
    item.textContent = `${row.matched ? "MATCH" : "NO MATCH"} - ${row.reason} - ${messageText}`;
    el.triggerHistoryList.appendChild(item);
  });
}

function selectedInspectionIso() {
  const raw = el.scheduleInspectAt.value;
  if (!raw) {
    return new Date().toISOString();
  }
  return new Date(raw).toISOString();
}

async function renderScheduleInspection() {
  const result = await appApi.automation.inspectSchedule({ atIso: selectedInspectionIso() });
  el.scheduleInspectionList.innerHTML = "";
  if (!result.ok) {
    const error = document.createElement("li");
    error.textContent = result.error;
    el.scheduleInspectionList.appendChild(error);
    return;
  }

  const header = document.createElement("li");
  header.className = "entity-item";
  header.textContent = `Inspection time: ${result.atIso}`;
  el.scheduleInspectionList.appendChild(header);

  result.triggerStates.forEach((trigger) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `trigger ${trigger.name}: ${formatScheduleStatus(trigger.state)}`;
    el.scheduleInspectionList.appendChild(item);
  });

  result.actionStates.forEach((action) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `action ${action.name}: ${formatScheduleStatus(action.state)}`;
    el.scheduleInspectionList.appendChild(item);
  });
}

async function renderDbOverview() {
  const data = await appApi.database.getOverview();
  el.dbCountsList.innerHTML = "";
  el.dbRecentEvents.innerHTML = "";
  el.dbRecentMessages.innerHTML = "";
  el.dbConsoleLogs.innerHTML = "";
  el.dbHttpTraffic.innerHTML = "";
  el.dbScreenshots.innerHTML = "";

  if (!data.ok) {
    el.dbPath.textContent = data.dbPath || "(unavailable)";
    const err = document.createElement("li");
    err.textContent = data.error || "Database not ready.";
    el.dbCountsList.appendChild(err);
    return;
  }

  el.dbPath.textContent = data.dbPath;
  Object.entries(data.counts).forEach(([table, count]) => {
    const item = document.createElement("li");
    item.textContent = `${table}: ${count}`;
    el.dbCountsList.appendChild(item);
  });

  data.recentAppEvents.forEach((evt) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `[${evt.createdAt}] ${evt.tabId} ${evt.eventType} ${JSON.stringify(evt.payload)}`;
    el.dbRecentEvents.appendChild(item);
  });

  data.recentMessages.forEach((msg) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `[${msg.createdAt}] ${msg.tabId} ${msg.source} | ${msg.title} | ${msg.body}`;
    el.dbRecentMessages.appendChild(item);
  });

  (data.recentConsoleLogs || []).forEach((log) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `[${log.createdAt}] ${log.tabId} lvl=${log.level} ${log.message} (${log.sourceId}:${log.line})`;
    el.dbConsoleLogs.appendChild(item);
  });

  (data.recentHttpTraffic || []).forEach((req) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `[${req.createdAt}] ${req.tabId} ${req.method} ${req.statusCode} ${req.resourceType} ${req.url}${req.error ? ` error=${req.error}` : ""}`;
    el.dbHttpTraffic.appendChild(item);
  });

  (data.recentScreenshots || []).forEach((shot) => {
    const item = document.createElement("li");
    item.className = "entity-item";
    item.textContent = `[${shot.createdAt}] ${shot.tabId} ${shot.width}x${shot.height} ${shot.filePath}`;
    el.dbScreenshots.appendChild(item);
  });
}

async function runDbQuery() {
  const sql = el.dbSql.value.trim();
  const result = await appApi.database.query({ sql });
  if (!result.ok) {
    el.dbQueryResult.textContent = `Error: ${result.error}`;
    return;
  }
  const output = {
    rowCount: result.rows.length,
    columns: result.columns,
    rows: result.rows
  };
  el.dbQueryResult.textContent = JSON.stringify(output, null, 2);
}

async function captureDiagnosticScreenshot() {
  const selected = el.diagScreenshotTab.value;
  const payload = selected === "__active__" ? {} : { tabId: selected };
  const result = await appApi.diagnostics.captureScreenshot(payload);
  if (!result.ok) {
    el.diagScreenshotMeta.textContent = `Error: ${result.error}`;
    el.diagScreenshotPreview.classList.add("hidden");
    el.diagScreenshotPreview.removeAttribute("src");
    return;
  }

  el.diagScreenshotMeta.textContent = `[${result.screenshot.createdAt}] ${result.screenshot.tabId} ${result.screenshot.width}x${result.screenshot.height} ${result.screenshot.filePath}`;
  el.diagScreenshotPreview.src = result.dataUrl;
  el.diagScreenshotPreview.classList.remove("hidden");
}

async function initializeForms() {
  el.llmForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await appApi.automation.setLlmSettings({
      provider: el.llmProvider.value,
      model: el.llmModel.value.trim(),
      endpointOverride: el.llmEndpoint.value.trim(),
      apiKey: el.llmApiKey.value.trim()
    });
  });

  el.actionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await appApi.automation.addAction({
      name: el.actionName.value.trim() || "Untitled Action",
      kind: el.actionKind.value,
      instructions: el.actionInstructions.value.trim(),
      scheduleText: el.actionSchedule.value.trim() || "always",
      useLlmGeneration: el.actionUseLlm.checked
    });
    el.actionName.value = "";
    el.actionInstructions.value = "";
    el.actionSchedule.value = "";
    el.actionUseLlm.checked = false;
    await renderActions();
    await renderTriggers();
    await renderScheduleInspection();
    if (currentActiveTab === "database") {
      await renderDbOverview();
    }
  });

  el.triggerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await appApi.automation.addTrigger({
      name: el.triggerName.value.trim() || "Untitled Trigger",
      sourceTab: el.triggerSourceTab.value,
      matchText: el.triggerMatchText.value.trim(),
      scheduleText: el.triggerSchedule.value.trim() || "always",
      actionIds: selectedActionIds(),
      useLlmGeneration: el.triggerUseLlm.checked
    });
    el.triggerName.value = "";
    el.triggerMatchText.value = "";
    el.triggerSchedule.value = "";
    el.triggerUseLlm.checked = false;
    renderActionPicker();
    await renderTriggers();
    await renderScheduleInspection();
    await renderTriggerHistory();
    if (currentActiveTab === "database") {
      await renderDbOverview();
    }
  });

  el.simulateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await appApi.automation.simulateMessage({
      tabId: el.simulateTab.value,
      title: el.simulateTitle.value.trim(),
      body: el.simulateBody.value.trim()
    });
    el.simulateTitle.value = "";
    el.simulateBody.value = "";
    await renderTriggerHistory();
    if (currentActiveTab === "database") {
      await renderDbOverview();
    }
  });

  el.historyTriggerSelect.addEventListener("change", async () => {
    await renderTriggerHistory();
  });

  el.scheduleInspectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await renderScheduleInspection();
  });

  el.dbRefresh.addEventListener("click", async () => {
    await renderDbOverview();
  });

  el.dbQueryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runDbQuery();
  });

  el.diagScreenshotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await captureDiagnosticScreenshot();
    await renderDbOverview();
  });
}

function registerRealtimeListeners() {
  appApi.tabs.onActiveChange(async ({ tabId }) => {
    currentActiveTab = tabId;
    await renderTabStrip();
    renderActiveState(await appApi.tabs.getActiveState());
    if (tabId === "database") {
      await renderDbOverview();
    }
  });

  appApi.tabs.onStateChange((state) => {
    if (state.tabId === currentActiveTab) {
      renderActiveState(state);
    }
  });

  appApi.automation.onEvent((event) => {
    appendEvent(event);
  });
}

async function bootstrap() {
  setDefaultInspectionTime();
  await renderTabStrip();
  registerRealtimeListeners();
  await initializeForms();
  await renderLlmSettings();
  await renderActions();
  await renderTriggers();
  await renderTriggerHistory();
  await renderScheduleInspection();
  await renderDbOverview();
  renderEvents(await appApi.automation.getRecentEvents());
  renderActiveState(await appApi.tabs.getActiveState());
}

bootstrap();
