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
  dbRowLimit: document.getElementById("db-row-limit"),
  dbFilter: document.getElementById("db-filter"),
  dbRefresh: document.getElementById("db-refresh"),
  dbViewTabs: document.getElementById("db-view-tabs"),
  dbExplorerView: document.getElementById("db-explorer-view"),
  dbToolsView: document.getElementById("db-tools-view"),
  dbSubtabs: document.getElementById("db-subtabs"),
  dbTableMeta: document.getElementById("db-table-meta"),
  dbTableResult: document.getElementById("db-table-result"),

  dbQueryForm: document.getElementById("db-query-form"),
  dbSql: document.getElementById("db-sql"),
  dbQueryResult: document.getElementById("db-query-result"),
  diagScreenshotForm: document.getElementById("diag-screenshot-form"),
  diagScreenshotTab: document.getElementById("diag-screenshot-tab"),
  diagScreenshotMeta: document.getElementById("diag-screenshot-meta"),
  diagScreenshotPreview: document.getElementById("diag-screenshot-preview"),
  diagOutlookRun: document.getElementById("diag-outlook-run"),
  diagOutlookLoadLast: document.getElementById("diag-outlook-load-last"),
  diagOutlookStatus: document.getElementById("diag-outlook-status"),
  diagOutlookLogPath: document.getElementById("diag-outlook-log-path"),
  diagOutlookLog: document.getElementById("diag-outlook-log")
};

let currentActiveTab = "";
let actionCache = [];
let triggerCache = [];
let dbTables = [];
let dbCounts = {};
let activeDbTable = "";
let activeDatabaseView = "explorer";
let activeDbColumns = [];
let activeDbRows = [];
let activeDbSort = { column: "", direction: "asc" };

function tabButtonClass(tabId) {
  return tabId === currentActiveTab ? "tab-button is-active" : "tab-button";
}

function dbSubtabClass(table) {
  return table === activeDbTable ? "tab-button is-active" : "tab-button";
}

function setActiveDatabaseView(view) {
  activeDatabaseView = view === "tools" ? "tools" : "explorer";
  const buttons = el.dbViewTabs.querySelectorAll("button[data-db-view]");
  buttons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.dbView === activeDatabaseView);
  });
  el.dbExplorerView.classList.toggle("hidden", activeDatabaseView !== "explorer");
  el.dbToolsView.classList.toggle("hidden", activeDatabaseView !== "tools");
}

function tableWithCountLabel(table) {
  const count = dbCounts[table];
  if (typeof count === "number") {
    return `${table} (${count})`;
  }
  return table;
}

function setDefaultInspectionTime() {
  if (el.scheduleInspectAt.value) {
    return;
  }
  const now = new Date();
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  el.scheduleInspectAt.value = localIso;
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

  const webTabs = data.tabs.filter((tab) => tab.type === "web");
  const sourceTabOptions = [{ id: "any", label: "Any source" }].concat(
    webTabs.map((tab) => ({ id: tab.id, label: tab.label }))
  );
  populateSelect(el.triggerSourceTab, sourceTabOptions);
  populateSelect(el.simulateTab, webTabs.map((tab) => ({ id: tab.id, label: tab.label })));
  populateSelect(
    el.diagScreenshotTab,
    [{ id: "__active__", label: "Active web tab" }].concat(
      webTabs.map((tab) => ({ id: tab.id, label: tab.label }))
    )
  );

  updateLocalPanelsVisibility();
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
      if (currentActiveTab === "database") {
        await renderDbExplorer();
      }
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
      if (currentActiveTab === "database") {
        await renderDbExplorer();
      }
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

function getDbRowLimit() {
  return Math.max(1, Math.min(500, Number(el.dbRowLimit.value) || 50));
}

function normalizeDbCellValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return String(value);
    }
  }
  return String(value);
}

function compareDbValues(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return normalizeDbCellValue(left).localeCompare(normalizeDbCellValue(right), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function setDbTableMessage(message) {
  el.dbTableResult.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "db-table-empty";
  empty.textContent = message;
  el.dbTableResult.appendChild(empty);
}

function filteredAndSortedDbRows() {
  const query = el.dbFilter.value.trim().toLowerCase();
  let rows = activeDbRows;

  if (query) {
    rows = rows.filter((row) =>
      activeDbColumns.some((column) => normalizeDbCellValue(row[column]).toLowerCase().includes(query))
    );
  }

  if (activeDbSort.column && activeDbColumns.includes(activeDbSort.column)) {
    rows = rows.slice().sort((leftRow, rightRow) => {
      const base = compareDbValues(leftRow[activeDbSort.column], rightRow[activeDbSort.column]);
      return activeDbSort.direction === "asc" ? base : -base;
    });
  }

  return { query, rows };
}

function handleDbSortColumnClick(column) {
  if (activeDbSort.column === column) {
    activeDbSort.direction = activeDbSort.direction === "asc" ? "desc" : "asc";
  } else {
    activeDbSort.column = column;
    activeDbSort.direction = "asc";
  }
  renderDbTableGrid();
}

function renderDbTableGrid() {
  const total = dbCounts[activeDbTable];
  const loaded = activeDbRows.length;
  const { query, rows } = filteredAndSortedDbRows();
  const filtered = rows.length;
  const sortText = activeDbSort.column ? ` | sorted ${activeDbSort.column} ${activeDbSort.direction}` : "";
  const filterText = query ? ` | filtered ${filtered} row(s)` : "";
  el.dbTableMeta.textContent = `${activeDbTable} | loaded ${loaded} row(s) | total ${total ?? "unknown"} row(s)${filterText}${sortText}`;

  if (activeDbColumns.length === 0) {
    setDbTableMessage("No rows found for this table.");
    return;
  }

  if (filtered === 0) {
    setDbTableMessage(query ? "No rows match the current search." : "No rows found for this table.");
    return;
  }

  el.dbTableResult.innerHTML = "";
  const table = document.createElement("table");
  table.className = "db-table-grid";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  activeDbColumns.forEach((column) => {
    const th = document.createElement("th");
    const isActiveSort = activeDbSort.column === column;
    th.setAttribute("aria-sort", isActiveSort ? (activeDbSort.direction === "asc" ? "ascending" : "descending") : "none");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "db-sort-button";
    const sortIndicator = isActiveSort ? (activeDbSort.direction === "asc" ? " (asc)" : " (desc)") : "";
    button.textContent = `${column}${sortIndicator}`;
    button.addEventListener("click", () => {
      handleDbSortColumnClick(column);
    });
    th.appendChild(button);
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    activeDbColumns.forEach((column) => {
      const td = document.createElement("td");
      const rawValue = row[column];
      if (rawValue === null || rawValue === undefined) {
        const nullText = document.createElement("span");
        nullText.className = "db-cell-null";
        nullText.textContent = "null";
        td.appendChild(nullText);
      } else {
        td.textContent = normalizeDbCellValue(rawValue);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);

  el.dbTableResult.appendChild(table);
}

function renderDbSubtabs() {
  el.dbSubtabs.innerHTML = "";
  dbTables.forEach((table) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = dbSubtabClass(table);
    button.textContent = tableWithCountLabel(table);
    button.addEventListener("click", async () => {
      activeDbTable = table;
      renderDbSubtabs();
      await renderActiveDbTable();
    });
    el.dbSubtabs.appendChild(button);
  });
}

async function renderActiveDbTable() {
  if (!activeDbTable) {
    el.dbTableMeta.textContent = "No table selected.";
    activeDbColumns = [];
    activeDbRows = [];
    setDbTableMessage("No table selected.");
    return;
  }

  const result = await appApi.database.getTableRows({ table: activeDbTable, limit: getDbRowLimit() });
  if (!result.ok) {
    el.dbTableMeta.textContent = `Error loading ${activeDbTable}: ${result.error}`;
    activeDbColumns = [];
    activeDbRows = [];
    setDbTableMessage("Unable to load this table.");
    return;
  }

  activeDbColumns = Array.isArray(result.columns) ? result.columns : [];
  activeDbRows = Array.isArray(result.rows) ? result.rows : [];
  if (!activeDbColumns.includes(activeDbSort.column)) {
    activeDbSort = { column: "", direction: "asc" };
  }
  renderDbTableGrid();
}

async function renderDbExplorer() {
  const overview = await appApi.database.getOverview();
  if (!overview.ok) {
    el.dbPath.textContent = overview.dbPath || "(unavailable)";
    el.dbTableMeta.textContent = overview.error || "Database not ready.";
    activeDbColumns = [];
    activeDbRows = [];
    setDbTableMessage("Database not ready.");
    el.dbSubtabs.innerHTML = "";
    return;
  }

  el.dbPath.textContent = overview.dbPath;
  dbTables = Array.isArray(overview.tables) ? overview.tables : Object.keys(overview.counts || {});
  dbCounts = overview.counts || {};
  if (!activeDbTable || !dbTables.includes(activeDbTable)) {
    const firstNonEmpty = dbTables.find((table) => Number(dbCounts[table] || 0) > 0);
    activeDbTable = firstNonEmpty || dbTables[0] || "";
  }
  renderDbSubtabs();
  await renderActiveDbTable();
}

async function runDbQuery() {
  const sql = el.dbSql.value.trim();
  const result = await appApi.database.query({ sql });
  if (!result.ok) {
    el.dbQueryResult.textContent = `Error: ${result.error}`;
    return;
  }
  el.dbQueryResult.textContent = JSON.stringify(
    {
      rowCount: result.rows.length,
      columns: result.columns,
      rows: result.rows
    },
    null,
    2
  );
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
  if (currentActiveTab === "database") {
    await renderDbExplorer();
  }
}

function renderOutlookAutomationRun(run) {
  if (!run) {
    el.diagOutlookStatus.textContent = "No Outlook capture run found.";
    el.diagOutlookLogPath.textContent = "(none)";
    el.diagOutlookLog.textContent = "";
    return;
  }
  el.diagOutlookStatus.textContent = `Outlook capture ${run.status || "unknown"} | started ${run.startedAt || "unknown"} | completed ${run.completedAt || "unknown"}`;
  el.diagOutlookLogPath.textContent = run.lastLogPath || run.logPath || "(none)";
  el.diagOutlookLog.textContent = JSON.stringify(run, null, 2);
}

async function loadLastOutlookCaptureAutomationRun() {
  const run = await appApi.diagnostics.getLastOutlookCaptureAutomation();
  renderOutlookAutomationRun(run);
}

async function runOutlookCaptureAutomation() {
  el.diagOutlookStatus.textContent = "Running Outlook capture automation...";
  const run = await appApi.diagnostics.runOutlookCaptureAutomation();
  renderOutlookAutomationRun(run);
  if (currentActiveTab === "database") {
    await renderDbExplorer();
  }
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
      await renderDbExplorer();
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
      await renderDbExplorer();
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
      await renderDbExplorer();
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
    await renderDbExplorer();
  });

  el.dbViewTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-db-view]");
    if (!button) {
      return;
    }
    setActiveDatabaseView(button.dataset.dbView);
  });

  el.dbRowLimit.addEventListener("change", async () => {
    if (currentActiveTab === "database") {
      await renderActiveDbTable();
    }
  });

  el.dbFilter.addEventListener("input", () => {
    if (currentActiveTab === "database" && activeDatabaseView === "explorer") {
      renderDbTableGrid();
    }
  });

  el.dbQueryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runDbQuery();
  });

  el.diagScreenshotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await captureDiagnosticScreenshot();
  });

  el.diagOutlookRun.addEventListener("click", async () => {
    await runOutlookCaptureAutomation();
  });

  el.diagOutlookLoadLast.addEventListener("click", async () => {
    await loadLastOutlookCaptureAutomationRun();
  });
}

function registerRealtimeListeners() {
  appApi.tabs.onActiveChange(async ({ tabId }) => {
    currentActiveTab = tabId;
    await renderTabStrip();
    renderActiveState(await appApi.tabs.getActiveState());
    if (tabId === "database") {
      await renderDbExplorer();
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
  setActiveDatabaseView(activeDatabaseView);
  await renderTabStrip();
  registerRealtimeListeners();
  await initializeForms();
  await renderLlmSettings();
  await renderActions();
  await renderTriggers();
  await renderTriggerHistory();
  await renderScheduleInspection();
  await renderDbExplorer();
  await loadLastOutlookCaptureAutomationRun();
  renderEvents(await appApi.automation.getRecentEvents());
  renderActiveState(await appApi.tabs.getActiveState());
}

bootstrap();
