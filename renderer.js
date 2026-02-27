const appApi = window.commMeFasterd;

const el = {
  tabs: document.getElementById("tabs"),
  settingsPanel: document.getElementById("settings-panel"),
  activeViewState: document.getElementById("active-view-state"),
  ruleForm: document.getElementById("rule-form"),
  triggerTab: document.getElementById("trigger-tab"),
  actionType: document.getElementById("action-type"),
  actionDetails: document.getElementById("action-details"),
  rulesList: document.getElementById("rules-list"),
  simulateTab: document.getElementById("simulate-tab"),
  simulateTitle: document.getElementById("simulate-title"),
  simulateBody: document.getElementById("simulate-body"),
  simulateForm: document.getElementById("simulate-form"),
  eventsList: document.getElementById("events-list")
};

let currentActiveTab = "";

function tabButtonClass(tabId) {
  return tabId === currentActiveTab ? "tab-button is-active" : "tab-button";
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
  populateTabSelect(el.triggerTab, webTabs);
  populateTabSelect(el.simulateTab, webTabs);
  updateSettingsVisibility();
}

function populateTabSelect(select, tabs) {
  select.innerHTML = "";
  tabs.forEach((tab) => {
    const option = document.createElement("option");
    option.value = tab.id;
    option.textContent = tab.label;
    select.appendChild(option);
  });
}

function updateSettingsVisibility() {
  const isSettings = currentActiveTab === "settings";
  el.settingsPanel.classList.toggle("hidden", !isSettings);
}

function renderActiveState(state) {
  if (!state || currentActiveTab === "settings") {
    el.activeViewState.textContent = "Settings tab is local.";
    return;
  }

  const summary = [
    `${state.tabId}`,
    `${state.loading ? "loading" : "idle"}`,
    `${state.title || "(no title)"}`,
    `${state.url || "(no url yet)"}`,
    `back:${state.canGoBack ? "y" : "n"}`,
    `forward:${state.canGoForward ? "y" : "n"}`
  ];
  el.activeViewState.textContent = summary.join(" | ");
}

async function renderRules() {
  const rules = await appApi.automation.listRules();
  el.rulesList.innerHTML = "";
  if (rules.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No rules yet.";
    el.rulesList.appendChild(empty);
    return;
  }

  rules.forEach((rule) => {
    const item = document.createElement("li");
    item.textContent = `${rule.id}: when ${rule.triggerTab} receives a message -> ${rule.actionType} (${rule.details || "no details"})`;
    el.rulesList.appendChild(item);
  });
}

function renderEvents(events) {
  el.eventsList.innerHTML = "";
  events.slice(0, 12).forEach((event) => appendEvent(event));
}

function appendEvent(event) {
  const item = document.createElement("li");
  item.textContent = `[${event.createdAt}] ${event.kind} ${event.actionType ? `(${event.actionType})` : ""} ${event.reason ? `- ${event.reason}` : ""}`;
  el.eventsList.prepend(item);
  while (el.eventsList.children.length > 20) {
    el.eventsList.removeChild(el.eventsList.lastChild);
  }
}

async function initializeForms() {
  el.ruleForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await appApi.automation.addRule({
      triggerTab: el.triggerTab.value,
      actionType: el.actionType.value,
      details: el.actionDetails.value.trim()
    });
    el.actionDetails.value = "";
    await renderRules();
  });

  el.simulateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await appApi.automation.simulateMessage({
      tabId: el.simulateTab.value,
      title: el.simulateTitle.value.trim(),
      body: el.simulateBody.value.trim()
    });
    el.simulateTitle.value = "";
    el.simulateBody.value = "";
  });
}

function registerRealtimeListeners() {
  appApi.tabs.onActiveChange(async ({ tabId }) => {
    currentActiveTab = tabId;
    await renderTabStrip();
    const state = await appApi.tabs.getActiveState();
    renderActiveState(state);
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
  await renderTabStrip();
  registerRealtimeListeners();
  await initializeForms();
  await renderRules();
  renderEvents(await appApi.automation.getRecentEvents());
  renderActiveState(await appApi.tabs.getActiveState());
}

bootstrap();
