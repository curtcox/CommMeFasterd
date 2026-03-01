const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, BrowserView, ipcMain } = require("electron");
const { collectCaptureFrameTargetsFromMainFrame } = require("./capture_frame_targets");
const { resolveOutlookMailUrl } = require("./outlook_target_url");
const { resolveTeamsWebUrl } = require("./teams_target_url");
const USER_DATA_DIR_OVERRIDE = String(process.env.COMMMEFASTERD_USER_DATA_DIR || "").trim();

if (USER_DATA_DIR_OVERRIDE) {
  try {
    fs.mkdirSync(USER_DATA_DIR_OVERRIDE, { recursive: true });
    app.setPath("userData", path.resolve(USER_DATA_DIR_OVERRIDE));
  } catch (error) {
    console.error(`[startup] failed to apply COMMMEFASTERD_USER_DATA_DIR override: ${error.message || String(error)}`);
  }
}

let sqlite3 = null;
try {
  sqlite3 = require("sqlite3").verbose();
} catch (_error) {
  sqlite3 = null;
}

const TAB_BAR_HEIGHT = 100;
const MAX_EVENTS = 400;
const MAX_MESSAGES = 400;
const MAX_EVALUATIONS = 1200;
const MAX_CONSOLE_LOGS = 800;
const MAX_HTTP_TRAFFIC = 1200;
const MAX_SCREENSHOTS = 200;
const DOM_CAPTURE_INTERVAL_MS = 6000;
const MAX_DOM_CAPTURE_KEYS = 20000;
const MAX_CAPTURE_FRAMES_PER_TAB = 16;
const OUTLOOK_AUTOMATION_NAV_WAIT_MS = 20000;
const OUTLOOK_AUTOMATION_POST_CLICK_WAIT_MS = 5000;
const TEAMS_AUTOMATION_CONTENT_WAIT_MS = 30000;
const OUTLOOK_AUTOMATION_LAST_RUN_FILE = "outlook-capture-last-run.json";
const OUTLOOK_AUTOMATION_AUTORUN_ARG = "--outlook-autorun";
const TEAMS_AUTOMATION_LAST_RUN_FILE = "teams-capture-last-run.json";
const TEAMS_AUTOMATION_AUTORUN_ARG = "--teams-autorun";
const APP_ICON_PATH = path.join(__dirname, "assets", "app-icon.png");

const DB_TABLES = [
  "llm_settings",
  "actions",
  "triggers",
  "messages",
  "trigger_evaluations",
  "automation_events",
  "app_events",
  "console_logs",
  "http_traffic",
  "screenshots"
];

const DB_TABLE_SORT = {
  llm_settings: "id DESC",
  actions: "created_at DESC",
  triggers: "created_at DESC",
  messages: "created_at DESC",
  trigger_evaluations: "created_at DESC",
  automation_events: "id DESC",
  app_events: "id DESC",
  console_logs: "created_at DESC",
  http_traffic: "created_at DESC",
  screenshots: "created_at DESC"
};

const TABS = [
  { id: "slack", label: "Slack", url: "https://app.slack.com/client", type: "web" },
  { id: "teams", label: "Teams", url: "https://teams.microsoft.com/v2/", type: "web" },
  { id: "office", label: "Office", url: "https://outlook.office.com/mail/", type: "web" },
  { id: "gmail", label: "Gmail", url: "https://mail.google.com", type: "web" },
  { id: "calendar", label: "Google Calendar", url: "https://calendar.google.com", type: "web" },
  { id: "google-voice", label: "Google Voice", url: "https://voice.google.com", type: "web" },
  { id: "elevenlabs", label: "ElevenLabs", url: "https://elevenlabs.io/app", type: "web" },
  { id: "settings", label: "Settings", type: "local" },
  { id: "database", label: "Database", type: "local" }
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
/** @type {Map<number, string>} */
const webContentsToTabId = new Map();
/** @type {Map<number, any>} */
const pendingNetworkRequests = new Map();
let activeTabId = "slack";
let screenshotsDir = "";
let diagnosticsDir = "";
let networkObserversInstalled = false;
let domCaptureIntervalHandle = null;
const domCaptureInFlightTabs = new Set();
const seenDomMessageKeys = new Set();
const seenDomMessageKeyQueue = [];
const pendingDbWritePromises = new Set();
let shuttingDownForQuit = false;
let quitCleanupCompleted = false;
let quitCleanupPromise = null;
let outlookAutomationRunInFlight = null;
let cachedLastOutlookAutomationRun = null;
let teamsAutomationRunInFlight = null;
let cachedLastTeamsAutomationRun = null;

/** @type {import("sqlite3").Database | null} */
let db = null;
let dbPath = "";
let dbReady = false;
let dbError = "";

const automationEvents = [];
const messageHistory = [];
const triggerEvaluations = [];
const consoleLogs = [];
const httpTraffic = [];
const screenshotHistory = [];
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeDomCaptureKeyPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function rememberDomMessageKey(key) {
  if (!key) {
    return false;
  }
  if (seenDomMessageKeys.has(key)) {
    return false;
  }
  seenDomMessageKeys.add(key);
  seenDomMessageKeyQueue.push(key);
  if (seenDomMessageKeyQueue.length > MAX_DOM_CAPTURE_KEYS) {
    const removed = seenDomMessageKeyQueue.shift();
    if (removed) {
      seenDomMessageKeys.delete(removed);
    }
  }
  return true;
}

function buildDomMessageDedupKey(tabId, candidate) {
  const source = normalizeDomCaptureKeyPart(candidate.source || "dom");
  const keyPart = normalizeDomCaptureKeyPart(
    candidate.key || `${candidate.title || ""}|${candidate.body || ""}`.slice(0, 600)
  );
  return `${tabId}|${source}|${keyPart}`;
}

function sanitizeCapturedMessageCandidate(candidate) {
  return {
    title: String(candidate.title || "").trim().slice(0, 300),
    body: String(candidate.body || "").trim().slice(0, 3000),
    source: String(candidate.source || "dom-capture").trim().slice(0, 120),
    key: String(candidate.key || "").trim().slice(0, 600)
  };
}

function collectVisibleMessagesFromDom() {
  const MAX_ITEMS = 120;
  const items = [];
  const seen = new Set();
  const documents = [document];

  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const frame of iframes) {
    try {
      if (frame.contentDocument && frame.contentDocument.documentElement) {
        documents.push(frame.contentDocument);
      }
    } catch (_error) {
      // Ignore cross-origin iframes.
    }
  }

  const host = String(location.hostname || "").toLowerCase();

  function buildQueryRoots() {
    const includeShadowRoots = host.includes("teams.microsoft.com");
    const roots = documents.slice();
    if (!includeShadowRoots) {
      return roots;
    }
    const seenRoots = new Set(roots);
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll("*"));
      } catch (_error) {
        nodes = [];
      }
      for (const node of nodes) {
        if (node && node.shadowRoot && !seenRoots.has(node.shadowRoot)) {
          seenRoots.add(node.shadowRoot);
          roots.push(node.shadowRoot);
        }
      }
    }
    return roots;
  }

  const queryRoots = buildQueryRoots();

  function normalize(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textFromNode(node) {
    return normalize(node && node.textContent ? node.textContent : "");
  }

  function firstText(root, selectors) {
    if (!root) {
      return "";
    }
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const text = textFromNode(node);
      if (text) {
        return text;
      }
    }
    return "";
  }

  function queryAllAcrossRoots(selector) {
    const nodes = [];
    const seenNodes = new Set();
    for (const root of queryRoots) {
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
      } catch (_error) {
        matches = [];
      }
      for (const match of matches) {
        if (seenNodes.has(match)) {
          continue;
        }
        seenNodes.add(match);
        nodes.push(match);
      }
    }
    return nodes;
  }

  function isVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return false;
    }
    const ownerWindow = (node.ownerDocument && node.ownerDocument.defaultView) || window;
    const style = ownerWindow.getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    return rect.bottom >= -50 && rect.top <= ownerWindow.innerHeight + 50;
  }

  function addItem(rawKey, title, body, source) {
    if (items.length >= MAX_ITEMS) {
      return;
    }
    const normalizedTitle = normalize(title).slice(0, 300);
    const normalizedBody = normalize(body).slice(0, 3000);
    if (!normalizedTitle && !normalizedBody) {
      return;
    }
    if (!normalizedBody && normalizedTitle.length < 3) {
      return;
    }
    const key = normalize(rawKey) || `${normalizedTitle}|${normalizedBody.slice(0, 180)}`;
    const dedupe = `${source}|${key}`.toLowerCase();
    if (seen.has(dedupe)) {
      return;
    }
    seen.add(dedupe);
    items.push({ key, title: normalizedTitle, body: normalizedBody, source });
  }

  function scanRows(selectors, parser) {
    for (const selector of selectors) {
      const nodes = queryAllAcrossRoots(selector);
      for (const node of nodes) {
        if (items.length >= MAX_ITEMS) {
          return;
        }
        if (!isVisible(node)) {
          continue;
        }
        parser(node);
      }
    }
  }

  if (host.includes("slack.com")) {
    scanRows(["[data-qa=\"message_container\"]", ".c-message_kit__background"], (row) => {
      const author = firstText(row, [
        "[data-qa=\"message_sender\"]",
        ".c-message__sender_link",
        ".c-message_kit__sender_button",
        ".c-message_kit__display_name"
      ]);
      const body =
        firstText(row, [
          "[data-qa=\"message-text\"]",
          ".c-message_kit__text",
          ".p-rich_text_section",
          ".c-message__body"
        ]) || textFromNode(row);
      const timestamp = firstText(row, ["a[data-qa=\"timestamp_link\"]", "time"]);
      const key =
        row.getAttribute("data-qa-message-id") ||
        row.getAttribute("data-message-id") ||
        row.id ||
        `${author}|${timestamp}|${body.slice(0, 180)}`;
      addItem(key, author || "Slack", body, "dom-slack");
    });
  } else if (host.includes("teams.microsoft.com")) {
    scanRows(
      [
        "[data-tid=\"chat-pane-message\"]",
        "[data-tid=\"message-thread-message\"]",
        "[data-tid=\"chat-pane-list-item\"]",
        "[id^=\"chat-pane-item_\"]",
        "[data-item-id][role=\"listitem\"]",
        "[role=\"listitem\"][data-tid]",
        "[data-tid*=\"message\" i]",
        "[data-tid*=\"chat\" i]",
        "[data-tid*=\"thread\" i]",
        "[data-testid*=\"message\" i]",
        "[data-testid*=\"chat\" i]",
        "[data-item-id]"
      ],
      (row) => {
        const rowText = textFromNode(row);
        if (!rowText || rowText.length < 6 || rowText.length > 3500) {
          return;
        }
        const rowTid = normalize(row.getAttribute("data-tid") || "");
        const hasMessageHint =
          /message|chat|chat-pane|thread|conversation/i.test(rowTid) ||
          Boolean(
            row.querySelector(
              "[data-tid*=\"message\" i], [data-tid*=\"chat\" i], [data-testid*=\"message\" i], [data-item-id], time"
            )
          );
        if (!hasMessageHint) {
          return;
        }
        const author = firstText(row, [
          "[data-tid=\"threadBodyDisplayName\"]",
          "[data-tid=\"message-author-name\"]",
          "[data-tid=\"chat-pane-message-sender\"]",
          "[data-tid*=\"display-name\"]",
          "[data-tid*=\"author\"]"
        ]);
        const body =
          firstText(row, [
            "[data-tid=\"chat-pane-message-content\"]",
            "[data-tid=\"messageBodyContent\"]",
            "[data-tid=\"richText\"]",
            "[data-tid*=\"message-body\"]",
            "[data-tid*=\"message-content\"]",
            "[data-tid*=\"messageBody\"]",
            "[data-testid*=\"message\" i]"
          ]) || rowText;
        if (!body || body.length < 6) {
          return;
        }
        const timestamp = firstText(row, ["[data-tid=\"message-timestamp\"]", "time"]);
        const key =
          row.getAttribute("data-message-id") ||
          row.getAttribute("data-item-id") ||
          row.id ||
          `${author}|${timestamp}|${body.slice(0, 180)}`;
        addItem(key, author || "Teams", body, "dom-teams");
      }
    );
    scanRows(
      [
        "[data-tid=\"messageBodyContent\"]",
        "[data-tid*=\"messageBody\"]",
        "[data-tid*=\"message-body\"]",
        "[data-tid*=\"message-content\"]",
        "[data-tid*=\"chat-message\"]",
        "[data-tid*=\"message\" i]",
        "[data-testid*=\"message\" i]"
      ],
      (row) => {
        const body = textFromNode(row);
        if (!body || body.length < 6 || body.length > 3000) {
          return;
        }
        const container = row.closest(
          "[data-tid=\"chat-pane-message\"], [data-tid=\"message-thread-message\"], [role=\"listitem\"], [data-item-id]"
        );
        const author = firstText(container || document, [
          "[data-tid=\"threadBodyDisplayName\"]",
          "[data-tid=\"message-author-name\"]",
          "[data-tid*=\"display-name\"]",
          "[data-tid*=\"author\"]"
        ]);
        const key =
          (container &&
            (container.getAttribute("data-message-id") ||
              container.getAttribute("data-item-id") ||
              container.id)) ||
          `${author}|${body.slice(0, 180)}`;
        addItem(key, author || "Teams", body, "dom-teams");
      }
    );
  } else if (host.includes("mail.google.com")) {
    scanRows(["tr.zA"], (row) => {
      const author = firstText(row, ["span[email]", ".yW span", ".yP"]);
      const subject = firstText(row, [".bog", ".bqe"]);
      const snippet = firstText(row, [".y2", ".y6"]);
      const body = normalize(`${subject} ${snippet}`);
      const key =
        row.getAttribute("data-legacy-message-id") ||
        row.getAttribute("data-thread-id") ||
        row.id ||
        `${author}|${body.slice(0, 180)}`;
      addItem(key, author || subject || "Gmail", body, "dom-gmail-list");
    });
    scanRows(["div.a3s.aiL", "div.a3s"], (row) => {
      const body = textFromNode(row);
      if (body.length < 10) {
        return;
      }
      const mailContainer = row.closest(".adn, .ii.gt");
      const author = firstText(mailContainer || document, [".gD", ".go", "h3.iw span[email]"]);
      const key =
        (mailContainer &&
          (mailContainer.getAttribute("data-legacy-message-id") || mailContainer.getAttribute("data-message-id"))) ||
        `${author}|${body.slice(0, 180)}`;
      addItem(key, author || "Gmail", body, "dom-gmail-open");
    });
  } else if (
    host.includes("office.com") ||
    host.includes("outlook.") ||
    host.includes("office365.com") ||
    host.includes("office365.us")
  ) {
    scanRows(
      [
        "div[role=\"option\"][data-convid]",
        "div[data-convid]",
        "[data-automationid=\"MessageListItem\"]",
        "div[role=\"row\"]",
        "div[role=\"article\"]"
      ],
      (row) => {
        const author = firstText(row, [
          "[data-automationid=\"MessageSender\"]",
          "[data-app-section=\"Sender\"]",
          ".ms-Persona-primaryText",
          "[data-app-section=\"PersonaHeader\"] span",
          "span[title*=\"@\"]"
        ]);
        const subject = firstText(row, [
          "[data-automationid=\"MessageSubject\"]",
          "[data-app-section=\"Subject\"]",
          "[data-app-section=\"MailReadComposeSubjectLine\"]",
          ".SubjectLine",
          "[role=\"heading\"]"
        ]);
        const preview = firstText(row, [
          "[data-automationid=\"MessagePreview\"]",
          "[data-app-section=\"PreviewText\"]",
          ".PreviewText",
          ".wellItemBody"
        ]);
        const rowText = textFromNode(row).slice(0, 700);
        const body = normalize(`${subject} ${preview} ${rowText}`);
        const key =
          row.getAttribute("data-convid") ||
          row.getAttribute("data-item-id") ||
          row.getAttribute("data-automationid") ||
          row.id ||
          `${author}|${subject}|${body.slice(0, 140)}`;
        addItem(key, author || subject || "Office", body, "dom-office");
      }
    );

    scanRows(
      [
        "[data-app-section=\"MailReadComposeBody\"]",
        "[data-automationid=\"ReadPane\"] div[role=\"document\"]",
        "div[aria-label*=\"Message body\"]",
        "div[role=\"document\"]"
      ],
      (row) => {
        const body = textFromNode(row);
        if (body.length < 20) {
          return;
        }
        const container =
          row.closest("[data-app-section=\"ReadingPaneContainer\"], [data-automationid=\"ReadPane\"]") ||
          row.parentElement ||
          row;
        const author = firstText(container, [
          "[data-automationid=\"MessageSender\"]",
          "[data-app-section=\"Sender\"]",
          ".ms-Persona-primaryText",
          "span[title*=\"@\"]"
        ]);
        const subject = firstText(container, [
          "[data-automationid=\"MessageSubject\"]",
          "[data-app-section=\"MailReadComposeSubjectLine\"]",
          "[role=\"heading\"]"
        ]);
        const key =
          container.getAttribute("data-convid") ||
          container.getAttribute("data-item-id") ||
          row.getAttribute("data-item-id") ||
          `${author}|${subject}|${body.slice(0, 160)}`;
        addItem(key, author || subject || "Office", `${subject} ${body}`.trim(), "dom-office-open");
      }
    );
  }

  if (items.length < 10) {
    scanRows(["[role=\"article\"]", "article", "[data-message-id]"], (row) => {
      const body = textFromNode(row);
      if (body.length < 20) {
        return;
      }
      const title = firstText(row, ["h1", "h2", "h3", "strong"]) || normalize(document.title);
      const key = row.getAttribute("data-message-id") || row.id || `${title}|${body.slice(0, 180)}`;
      addItem(key, title || "Message", body, "dom-generic");
    });
  }

  return {
    host,
    url: location.href,
    items: items.slice(0, MAX_ITEMS)
  };
}

const DOM_CAPTURE_SCRIPT = `(${collectVisibleMessagesFromDom.toString()})();`;

function collectCaptureFrameTargets(wc) {
  return collectCaptureFrameTargetsFromMainFrame(wc && wc.mainFrame, MAX_CAPTURE_FRAMES_PER_TAB);
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

const OUTLOOK_OPEN_FIRST_MESSAGE_SCRIPT = `(() => {
  function isVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    return rect.bottom >= -50 && rect.top <= window.innerHeight + 50;
  }

  const selectors = [
    "[data-automationid='MessageListItem']",
    "div[role='row']",
    "div[role='option'][data-convid]",
    "div[data-convid]",
    "tr[role='row']"
  ];

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }
      try {
        node.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_error) {
        // Ignore scroll issues.
      }
      node.click();
      const text = String(node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 220);
      return {
        clicked: true,
        selector,
        textSnippet: text
      };
    }
  }

  return {
    clicked: false,
    selector: "",
    textSnippet: ""
  };
})();`;

const TEAMS_DOM_PROBE_SCRIPT = `(() => {
  function isVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    return rect.bottom >= -50 && rect.top <= window.innerHeight + 50;
  }

  function collectRoots() {
    const roots = [document];
    const seenRoots = new Set(roots);
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const nodes = Array.from(root.querySelectorAll("*"));
      for (const node of nodes) {
        if (node && node.shadowRoot && !seenRoots.has(node.shadowRoot)) {
          seenRoots.add(node.shadowRoot);
          roots.push(node.shadowRoot);
        }
      }
    }
    return roots;
  }

  function queryAllFromRoots(roots, selector) {
    const nodes = [];
    const seen = new Set();
    for (const root of roots) {
      for (const node of Array.from(root.querySelectorAll(selector))) {
        if (seen.has(node)) {
          continue;
        }
        seen.add(node);
        nodes.push(node);
      }
    }
    return nodes;
  }

  const roots = collectRoots();
  const selectors = [
    "[data-tid='chat-pane-list-item']",
    "[data-tid='chat-pane-message']",
    "[data-tid='message-thread-message']",
    "[data-tid='messageBodyContent']",
    "[id^='chat-pane-item_']",
    "[data-item-id][role='listitem']",
    "[role='listitem'][data-tid]",
    "[data-tid*='message' i]",
    "[data-tid*='chat' i]",
    "[data-tid*='thread' i]",
    "[data-testid*='message' i]",
    "[data-testid*='chat' i]",
    "[data-item-id]"
  ];
  const selectorCounts = [];
  let totalVisibleMessageNodes = 0;

  for (const selector of selectors) {
    const matches = queryAllFromRoots(roots, selector);
    let visibleCount = 0;
    for (const node of matches) {
      if (isVisible(node)) {
        visibleCount += 1;
      }
    }
    if (matches.length > 0 || visibleCount > 0) {
      selectorCounts.push({
        selector,
        totalCount: matches.length,
        visibleCount
      });
    }
    totalVisibleMessageNodes += visibleCount;
  }

  const sampleDataTid = [];
  const seenTid = new Set();
  for (const node of queryAllFromRoots(roots, "[data-tid]")) {
    const value = String(node.getAttribute("data-tid") || "").trim();
    if (!value || seenTid.has(value)) {
      continue;
    }
    seenTid.add(value);
    sampleDataTid.push(value);
    if (sampleDataTid.length >= 300) {
      break;
    }
  }

  const sampleDataTestId = [];
  const seenTestId = new Set();
  for (const node of queryAllFromRoots(roots, "[data-testid]")) {
    const value = String(node.getAttribute("data-testid") || "").trim();
    if (!value || seenTestId.has(value)) {
      continue;
    }
    seenTestId.add(value);
    sampleDataTestId.push(value);
    if (sampleDataTestId.length >= 150) {
      break;
    }
  }

  const sampleListItems = [];
  for (const node of queryAllFromRoots(roots, "[role='listitem'], [data-item-id]")) {
    if (!isVisible(node)) {
      continue;
    }
    const text = String(node.textContent || "").replace(/\\s+/g, " ").trim();
    if (text.length < 4) {
      continue;
    }
    sampleListItems.push({
      dataTid: String(node.getAttribute("data-tid") || ""),
      dataTestId: String(node.getAttribute("data-testid") || ""),
      dataItemId: String(node.getAttribute("data-item-id") || ""),
      text: text.slice(0, 220)
    });
    if (sampleListItems.length >= 30) {
      break;
    }
  }

  return {
    url: location.href,
    title: document.title || "",
    readyState: document.readyState || "",
    rootCount: roots.length,
    totalVisibleMessageNodes,
    selectorCounts,
    sampleDataTid,
    sampleDataTestId,
    sampleListItems
  };
})();`;

const TEAMS_OPEN_FIRST_MESSAGE_SCRIPT = `(() => {
  function isVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    return rect.bottom >= -50 && rect.top <= window.innerHeight + 50;
  }

  function collectRoots() {
    const roots = [document];
    const seenRoots = new Set(roots);
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const nodes = Array.from(root.querySelectorAll("*"));
      for (const node of nodes) {
        if (node && node.shadowRoot && !seenRoots.has(node.shadowRoot)) {
          seenRoots.add(node.shadowRoot);
          roots.push(node.shadowRoot);
        }
      }
    }
    return roots;
  }

  function queryAllFromRoots(roots, selector) {
    const nodes = [];
    const seen = new Set();
    for (const root of roots) {
      for (const node of Array.from(root.querySelectorAll(selector))) {
        if (seen.has(node)) {
          continue;
        }
        seen.add(node);
        nodes.push(node);
      }
    }
    return nodes;
  }

  const roots = collectRoots();
  const selectors = [
    "[data-tid='chat-pane-list-item']",
    "[data-tid='chat-pane-message']",
    "[data-tid='message-thread-message']",
    "[data-tid='messageBodyContent']",
    "[id^='chat-pane-item_']",
    "[data-item-id][role='listitem']",
    "[role='listitem'][data-tid]",
    "[data-tid*='message' i]",
    "[data-tid*='chat' i]",
    "[data-tid*='thread' i]",
    "[data-testid*='message' i]",
    "[data-testid*='chat' i]",
    "[data-item-id]",
    "[role='listitem']"
  ];

  for (const selector of selectors) {
    const nodes = queryAllFromRoots(roots, selector);
    for (const node of nodes) {
      const clickTarget =
        node.closest("[role='listitem'], [data-item-id], [role='button'], button, a") || node;
      if (!isVisible(clickTarget)) {
        continue;
      }
      const text = String(node.textContent || clickTarget.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length < 4) {
        continue;
      }
      try {
        clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_error) {
        // Ignore scroll issues.
      }
      clickTarget.click();
      return {
        clicked: true,
        selector,
        textSnippet: text.slice(0, 220)
      };
    }
  }

  return {
    clicked: false,
    selector: "",
    textSnippet: ""
  };
})();`;

function isOutlookLikeMessageSource(source) {
  const text = String(source || "").toLowerCase();
  return text.includes("dom-office") || text.includes("outlook.");
}

function countOutlookCapturedMessagesInHistory() {
  return messageHistory.filter((message) => message.tabId === "office" && isOutlookLikeMessageSource(message.source)).length;
}

function isTeamsLikeMessageSource(source) {
  const text = String(source || "").toLowerCase();
  return text.includes("dom-teams") || text.includes("teams.microsoft.com");
}

function countTeamsCapturedMessagesInHistory() {
  return messageHistory.filter((message) => message.tabId === "teams" && isTeamsLikeMessageSource(message.source)).length;
}

function buildOutlookAutomationRun(reason) {
  return {
    id: newId("outlook_run"),
    reason: reason || "manual",
    startedAt: nowIso(),
    completedAt: "",
    status: "running",
    summary: {},
    steps: [],
    logPath: ""
  };
}

function buildTeamsAutomationRun(reason) {
  return {
    id: newId("teams_run"),
    reason: reason || "manual",
    startedAt: nowIso(),
    completedAt: "",
    status: "running",
    summary: {},
    steps: [],
    logPath: ""
  };
}

function pushOutlookAutomationStep(run, kind, details) {
  run.steps.push({
    at: nowIso(),
    kind,
    details: details || {}
  });
}

function pushTeamsAutomationStep(run, kind, details) {
  run.steps.push({
    at: nowIso(),
    kind,
    details: details || {}
  });
}

function outlookLastRunPath() {
  if (!diagnosticsDir) {
    return "";
  }
  return path.join(diagnosticsDir, OUTLOOK_AUTOMATION_LAST_RUN_FILE);
}

function teamsLastRunPath() {
  if (!diagnosticsDir) {
    return "";
  }
  return path.join(diagnosticsDir, TEAMS_AUTOMATION_LAST_RUN_FILE);
}

function readLastOutlookAutomationRunFromDisk() {
  const logPath = outlookLastRunPath();
  if (!logPath || !fs.existsSync(logPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(logPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function readLastTeamsAutomationRunFromDisk() {
  const logPath = teamsLastRunPath();
  if (!logPath || !fs.existsSync(logPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(logPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function persistOutlookAutomationRun(run) {
  cachedLastOutlookAutomationRun = run;
  if (!diagnosticsDir) {
    return;
  }
  try {
    const timestamp = run.startedAt.replace(/[:.]/g, "-");
    const runPath = path.join(diagnosticsDir, `outlook-capture-run-${timestamp}.json`);
    const lastPath = outlookLastRunPath();
    run.logPath = runPath;
    run.lastLogPath = lastPath;
    const body = JSON.stringify(run, null, 2);
    fs.writeFileSync(runPath, body);
    fs.writeFileSync(lastPath, body);
  } catch (error) {
    run.summary = {
      ...(run.summary || {}),
      logWriteError: error.message || "Failed writing run log"
    };
  }
}

function persistTeamsAutomationRun(run) {
  cachedLastTeamsAutomationRun = run;
  if (!diagnosticsDir) {
    return;
  }
  try {
    const timestamp = run.startedAt.replace(/[:.]/g, "-");
    const runPath = path.join(diagnosticsDir, `teams-capture-run-${timestamp}.json`);
    const lastPath = teamsLastRunPath();
    run.logPath = runPath;
    run.lastLogPath = lastPath;
    const body = JSON.stringify(run, null, 2);
    fs.writeFileSync(runPath, body);
    fs.writeFileSync(lastPath, body);
  } catch (error) {
    run.summary = {
      ...(run.summary || {}),
      logWriteError: error.message || "Failed writing run log"
    };
  }
}

async function waitForWebContentsIdle(wc, timeoutMs) {
  const startedMs = Date.now();
  while (Date.now() - startedMs < timeoutMs) {
    if (!wc || wc.isDestroyed()) {
      return { ok: false, reason: "webContents destroyed" };
    }
    if (!wc.isLoading()) {
      return { ok: true, reason: "idle" };
    }
    await sleep(250);
  }
  return { ok: false, reason: `timed out after ${timeoutMs}ms` };
}

async function probeTeamsDomInTab(tabId) {
  const view = tabViews.get(tabId);
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return { ok: false, error: "tab view unavailable", frameCount: 0, frames: [] };
  }
  const frames = collectCaptureFrameTargets(view.webContents);
  const frameReports = [];
  let totalVisibleMessageNodes = 0;
  for (const frame of frames) {
    const frameUrl = typeof frame.url === "string" ? frame.url : "";
    try {
      const result = await frame.executeJavaScript(TEAMS_DOM_PROBE_SCRIPT);
      const visibleCount = Number((result && result.totalVisibleMessageNodes) || 0);
      totalVisibleMessageNodes += visibleCount;
      frameReports.push({
        frameUrl,
        url: (result && result.url) || frameUrl,
        title: (result && result.title) || "",
        readyState: (result && result.readyState) || "",
        rootCount: Number((result && result.rootCount) || 0),
        totalVisibleMessageNodes: visibleCount,
        selectorCounts: Array.isArray(result && result.selectorCounts) ? result.selectorCounts : [],
        sampleDataTid: Array.isArray(result && result.sampleDataTid) ? result.sampleDataTid : []
      });
    } catch (error) {
      frameReports.push({
        frameUrl,
        error: error.message || "executeJavaScript failed"
      });
    }
  }
  const firstFrame = frameReports[0] || {};
  return {
    ok: true,
    tabId,
    frameCount: frameReports.length,
    totalVisibleMessageNodes,
    title: firstFrame.title || "",
    url: firstFrame.url || "",
    frames: frameReports
  };
}

async function waitForTeamsContentReady(tabId, timeoutMs) {
  const startedMs = Date.now();
  let lastProbe = null;
  while (Date.now() - startedMs < timeoutMs) {
    const probe = await probeTeamsDomInTab(tabId);
    lastProbe = probe;
    if (probe && probe.ok && Number(probe.totalVisibleMessageNodes || 0) > 0) {
      return {
        ok: true,
        reason: "visible-message-nodes-detected",
        waitedMs: Date.now() - startedMs,
        probe
      };
    }
    const hasMessageCandidates =
      probe &&
      Array.isArray(probe.frames) &&
      probe.frames.some((frame) =>
        Array.isArray(frame.selectorCounts) &&
        frame.selectorCounts.some((count) => Number((count && count.totalCount) || 0) > 0)
      );
    if (hasMessageCandidates) {
      return {
        ok: true,
        reason: "message-candidate-selectors-detected",
        waitedMs: Date.now() - startedMs,
        probe
      };
    }
    await sleep(1000);
  }
  return {
    ok: false,
    reason: `timed out after ${timeoutMs}ms`,
    waitedMs: Date.now() - startedMs,
    probe: lastProbe
  };
}

async function tryOpenOutlookMessageInTab(tabId) {
  const view = tabViews.get(tabId);
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return { clicked: false, error: "tab view unavailable", attempts: [] };
  }
  const frames = collectCaptureFrameTargets(view.webContents);
  const attempts = [];
  for (const frame of frames) {
    const frameUrl = typeof frame.url === "string" ? frame.url : "";
    try {
      const result = await frame.executeJavaScript(OUTLOOK_OPEN_FIRST_MESSAGE_SCRIPT);
      attempts.push({
        frameUrl,
        clicked: Boolean(result && result.clicked),
        selector: (result && result.selector) || "",
        textSnippet: (result && result.textSnippet) || ""
      });
      if (result && result.clicked) {
        return { clicked: true, frameUrl, selector: result.selector || "", textSnippet: result.textSnippet || "", attempts };
      }
    } catch (error) {
      attempts.push({
        frameUrl,
        clicked: false,
        error: error.message || "executeJavaScript failed"
      });
    }
  }
  return { clicked: false, error: "no visible message row found", attempts };
}

async function tryOpenTeamsMessageInTab(tabId) {
  const view = tabViews.get(tabId);
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return { clicked: false, error: "tab view unavailable", attempts: [] };
  }
  const frames = collectCaptureFrameTargets(view.webContents);
  const attempts = [];
  for (const frame of frames) {
    const frameUrl = typeof frame.url === "string" ? frame.url : "";
    try {
      const result = await frame.executeJavaScript(TEAMS_OPEN_FIRST_MESSAGE_SCRIPT);
      attempts.push({
        frameUrl,
        clicked: Boolean(result && result.clicked),
        selector: (result && result.selector) || "",
        textSnippet: (result && result.textSnippet) || ""
      });
      if (result && result.clicked) {
        return { clicked: true, frameUrl, selector: result.selector || "", textSnippet: result.textSnippet || "", attempts };
      }
    } catch (error) {
      attempts.push({
        frameUrl,
        clicked: false,
        error: error.message || "executeJavaScript failed"
      });
    }
  }
  return { clicked: false, error: "no visible teams message row found", attempts };
}

async function captureVisibleMessagesFromTab(tabId, options = {}) {
  const report = {
    ok: false,
    tabId,
    trigger: options.trigger || "capture-loop",
    startedAt: nowIso(),
    completedAt: "",
    tabUrl: "",
    frameCount: 0,
    candidateCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    frameReports: [],
    errors: []
  };
  if (domCaptureInFlightTabs.has(tabId)) {
    report.errors.push("capture already in progress");
    report.completedAt = nowIso();
    return report;
  }
  const view = tabViews.get(tabId);
  if (!view) {
    report.errors.push("tab view not found");
    report.completedAt = nowIso();
    return report;
  }
  const wc = view.webContents;
  if (!wc || wc.isDestroyed() || wc.isLoading()) {
    report.errors.push("webContents unavailable or loading");
    report.completedAt = nowIso();
    return report;
  }
  const url = wc.getURL();
  if (!url || !/^https?:/i.test(url)) {
    report.errors.push(`unsupported url "${url || "(empty)"}"`);
    report.completedAt = nowIso();
    return report;
  }

  if (tabId === "teams") {
    const normalizedTeamsUrl = resolveTeamsWebUrl(url);
    if (normalizedTeamsUrl !== url) {
      report.teamsUrlNormalizedTo = normalizedTeamsUrl;
      try {
        await wc.loadURL(normalizedTeamsUrl);
        const idle = await waitForWebContentsIdle(wc, OUTLOOK_AUTOMATION_NAV_WAIT_MS);
        report.teamsUrlNormalizationIdle = idle;
      } catch (error) {
        report.errors.push(`teams url normalization failed: ${error.message || "unknown error"}`);
      }
    }
  }
  report.tabUrl = wc.getURL();

  domCaptureInFlightTabs.add(tabId);
  try {
    const frames = collectCaptureFrameTargets(wc);
    report.frameCount = frames.length;
    for (const frame of frames) {
      const frameReport = {
        frameUrl: typeof frame.url === "string" ? frame.url : "",
        resultUrl: "",
        candidateCount: 0,
        insertedCount: 0,
        duplicateCount: 0,
        error: ""
      };
      let result = null;
      try {
        result = await frame.executeJavaScript(DOM_CAPTURE_SCRIPT);
      } catch (_error) {
        frameReport.error = _error && _error.message ? _error.message : "executeJavaScript failed";
        report.frameReports.push(frameReport);
        continue;
      }

      const candidates = result && Array.isArray(result.items) ? result.items : [];
      frameReport.resultUrl = String((result && result.url) || "");
      frameReport.candidateCount = candidates.length;
      report.candidateCount += candidates.length;
      const frameHost = hostFromUrl((result && result.url) || frame.url || url);
      for (const rawCandidate of candidates) {
        const candidate = sanitizeCapturedMessageCandidate(rawCandidate || {});
        if (!candidate.title && !candidate.body) {
          continue;
        }
        const sourceWithHost = frameHost
          ? `${candidate.source || "dom-capture"}:${frameHost}`.slice(0, 120)
          : candidate.source || "dom-capture";
        const dedupeKey = buildDomMessageDedupKey(tabId, { ...candidate, source: sourceWithHost });
        if (!rememberDomMessageKey(dedupeKey)) {
          frameReport.duplicateCount += 1;
          report.duplicateCount += 1;
          continue;
        }
        addMessage(tabId, {
          title: candidate.title,
          body: candidate.body,
          source: sourceWithHost
        });
        frameReport.insertedCount += 1;
        report.insertedCount += 1;
      }
      report.frameReports.push(frameReport);
    }
    report.ok = true;
  } catch (_error) {
    report.errors.push(_error && _error.message ? _error.message : "capture failed");
  } finally {
    report.completedAt = nowIso();
    domCaptureInFlightTabs.delete(tabId);
  }
  return report;
}

async function runOutlookCaptureAutomation(reason) {
  if (outlookAutomationRunInFlight) {
    return outlookAutomationRunInFlight;
  }

  const runPromise = (async () => {
    const run = buildOutlookAutomationRun(reason);
    try {
      pushOutlookAutomationStep(run, "start", {
        activeTabId,
        hasMainWindow: Boolean(mainWindow),
        diagnosticsDir: diagnosticsDir || "(not initialized)"
      });

      const officeView = tabViews.get("office");
      if (!officeView || !officeView.webContents || officeView.webContents.isDestroyed()) {
        run.status = "failed";
        run.summary = { error: "Office tab view is not available." };
        pushOutlookAutomationStep(run, "failed", run.summary);
        run.completedAt = nowIso();
        persistOutlookAutomationRun(run);
        return run;
      }

      switchToTab("office");
      pushOutlookAutomationStep(run, "switch-tab", {
        switchedTo: "office",
        officeUrl: officeView.webContents.getURL()
      });

      const currentOfficeUrl = officeView.webContents.getURL();
      const targetOutlookUrl = resolveOutlookMailUrl(currentOfficeUrl);
      if (targetOutlookUrl !== currentOfficeUrl) {
        pushOutlookAutomationStep(run, "navigate-outlook-mail", {
          from: currentOfficeUrl || "(empty)",
          to: targetOutlookUrl
        });
        try {
          await officeView.webContents.loadURL(targetOutlookUrl);
        } catch (error) {
          pushOutlookAutomationStep(run, "navigate-outlook-mail-error", {
            error: error.message || "Failed to load Outlook mail URL"
          });
        }
      }

      const idleResult = await waitForWebContentsIdle(officeView.webContents, OUTLOOK_AUTOMATION_NAV_WAIT_MS);
      pushOutlookAutomationStep(run, "wait-idle", idleResult);

      const beforeCount = countOutlookCapturedMessagesInHistory();
      pushOutlookAutomationStep(run, "before-count", { beforeCount });

      const preClickCapture = await captureVisibleMessagesFromTab("office", { trigger: "automation-pre-click" });
      pushOutlookAutomationStep(run, "capture-pre-click", preClickCapture);

      const clickResult = await tryOpenOutlookMessageInTab("office");
      pushOutlookAutomationStep(run, "open-first-message", clickResult);

      if (clickResult.clicked) {
        await sleep(OUTLOOK_AUTOMATION_POST_CLICK_WAIT_MS);
        pushOutlookAutomationStep(run, "wait-post-click", { waitedMs: OUTLOOK_AUTOMATION_POST_CLICK_WAIT_MS });
      }

      const postClickCapture = await captureVisibleMessagesFromTab("office", { trigger: "automation-post-click" });
      pushOutlookAutomationStep(run, "capture-post-click", postClickCapture);

      const afterCount = countOutlookCapturedMessagesInHistory();
      const delta = afterCount - beforeCount;
      const insertedTotal =
        Number(preClickCapture.insertedCount || 0) + Number(postClickCapture.insertedCount || 0);

      run.summary = {
        beforeCount,
        afterCount,
        delta,
        clickedMessage: Boolean(clickResult.clicked),
        insertedTotal,
        officeUrl: officeView.webContents.getURL(),
        officeTitle: officeView.webContents.getTitle()
      };
      run.status = delta > 0 || insertedTotal > 0 ? "passed" : "failed";
      pushOutlookAutomationStep(run, "summary", run.summary);
    } catch (error) {
      run.status = "failed";
      run.summary = { error: error.message || "Automation failed unexpectedly." };
      pushOutlookAutomationStep(run, "exception", run.summary);
    }

    run.completedAt = nowIso();
    persistOutlookAutomationRun(run);
    return run;
  })();

  outlookAutomationRunInFlight = runPromise;
  try {
    return await runPromise;
  } finally {
    outlookAutomationRunInFlight = null;
  }
}

async function runTeamsCaptureAutomation(reason) {
  if (teamsAutomationRunInFlight) {
    return teamsAutomationRunInFlight;
  }

  const runPromise = (async () => {
    const run = buildTeamsAutomationRun(reason);
    try {
      pushTeamsAutomationStep(run, "start", {
        activeTabId,
        hasMainWindow: Boolean(mainWindow),
        diagnosticsDir: diagnosticsDir || "(not initialized)"
      });

      const teamsView = tabViews.get("teams");
      if (!teamsView || !teamsView.webContents || teamsView.webContents.isDestroyed()) {
        run.status = "failed";
        run.summary = { error: "Teams tab view is not available." };
        pushTeamsAutomationStep(run, "failed", run.summary);
        run.completedAt = nowIso();
        persistTeamsAutomationRun(run);
        return run;
      }

      switchToTab("teams");
      pushTeamsAutomationStep(run, "switch-tab", {
        switchedTo: "teams",
        teamsUrl: teamsView.webContents.getURL()
      });

      const currentTeamsUrl = teamsView.webContents.getURL();
      const targetTeamsUrl = resolveTeamsWebUrl(currentTeamsUrl);
      if (targetTeamsUrl !== currentTeamsUrl) {
        pushTeamsAutomationStep(run, "navigate-teams-web", {
          from: currentTeamsUrl || "(empty)",
          to: targetTeamsUrl
        });
        try {
          await teamsView.webContents.loadURL(targetTeamsUrl);
        } catch (error) {
          pushTeamsAutomationStep(run, "navigate-teams-web-error", {
            error: error.message || "Failed to load Teams web URL"
          });
        }
      }

      const idleResult = await waitForWebContentsIdle(teamsView.webContents, OUTLOOK_AUTOMATION_NAV_WAIT_MS);
      pushTeamsAutomationStep(run, "wait-idle", idleResult);

      const contentReady = await waitForTeamsContentReady("teams", TEAMS_AUTOMATION_CONTENT_WAIT_MS);
      pushTeamsAutomationStep(run, "wait-content-ready", contentReady);

      const preCaptureProbe = await probeTeamsDomInTab("teams");
      pushTeamsAutomationStep(run, "probe-pre-capture", preCaptureProbe);

      const beforeCount = countTeamsCapturedMessagesInHistory();
      pushTeamsAutomationStep(run, "before-count", { beforeCount });

      const preClickCapture = await captureVisibleMessagesFromTab("teams", { trigger: "automation-pre-click" });
      pushTeamsAutomationStep(run, "capture-pre-click", preClickCapture);

      const clickResult = await tryOpenTeamsMessageInTab("teams");
      pushTeamsAutomationStep(run, "open-first-message", clickResult);

      if (clickResult.clicked) {
        await sleep(OUTLOOK_AUTOMATION_POST_CLICK_WAIT_MS);
        pushTeamsAutomationStep(run, "wait-post-click", { waitedMs: OUTLOOK_AUTOMATION_POST_CLICK_WAIT_MS });
      }

      const postClickProbe = await probeTeamsDomInTab("teams");
      pushTeamsAutomationStep(run, "probe-post-click", postClickProbe);

      const postClickCapture = await captureVisibleMessagesFromTab("teams", { trigger: "automation-post-click" });
      pushTeamsAutomationStep(run, "capture-post-click", postClickCapture);

      const afterCount = countTeamsCapturedMessagesInHistory();
      const delta = afterCount - beforeCount;
      const insertedTotal =
        Number(preClickCapture.insertedCount || 0) + Number(postClickCapture.insertedCount || 0);

      run.summary = {
        beforeCount,
        afterCount,
        delta,
        clickedMessage: Boolean(clickResult.clicked),
        insertedTotal,
        teamsUrl: teamsView.webContents.getURL(),
        teamsTitle: teamsView.webContents.getTitle()
      };
      run.status = delta > 0 || insertedTotal > 0 ? "passed" : "failed";
      pushTeamsAutomationStep(run, "summary", run.summary);
    } catch (error) {
      run.status = "failed";
      run.summary = { error: error.message || "Automation failed unexpectedly." };
      pushTeamsAutomationStep(run, "exception", run.summary);
    }

    run.completedAt = nowIso();
    persistTeamsAutomationRun(run);
    return run;
  })();

  teamsAutomationRunInFlight = runPromise;
  try {
    return await runPromise;
  } finally {
    teamsAutomationRunInFlight = null;
  }
}

function getLastOutlookAutomationRun() {
  if (cachedLastOutlookAutomationRun) {
    return cachedLastOutlookAutomationRun;
  }
  const run = readLastOutlookAutomationRunFromDisk();
  if (run) {
    cachedLastOutlookAutomationRun = run;
  }
  return run;
}

function getLastTeamsAutomationRun() {
  if (cachedLastTeamsAutomationRun) {
    return cachedLastTeamsAutomationRun;
  }
  const run = readLastTeamsAutomationRunFromDisk();
  if (run) {
    cachedLastTeamsAutomationRun = run;
  }
  return run;
}

function shouldAutoRunOutlookAutomation() {
  return process.argv.includes(OUTLOOK_AUTOMATION_AUTORUN_ARG) || process.env.COMMMEFASTERD_OUTLOOK_AUTORUN === "1";
}

function shouldAutoRunTeamsAutomation() {
  return process.argv.includes(TEAMS_AUTOMATION_AUTORUN_ARG) || process.env.COMMMEFASTERD_TEAMS_AUTORUN === "1";
}

function shouldRunCaptureAutorun() {
  return shouldAutoRunOutlookAutomation() || shouldAutoRunTeamsAutomation();
}

function requestVisibleMessageCapture(tabId) {
  captureVisibleMessagesFromTab(tabId).catch(() => {
    // Ignore capture errors in background polling.
  });
}

async function captureVisibleMessagesFromAllTabs() {
  for (const tab of TABS) {
    if (tab.type !== "web") {
      continue;
    }
    await captureVisibleMessagesFromTab(tab.id);
  }
}

function startVisibleMessageCaptureLoop() {
  if (domCaptureIntervalHandle) {
    return;
  }
  domCaptureIntervalHandle = setInterval(() => {
    captureVisibleMessagesFromAllTabs().catch(() => {
      // Keep polling loop alive.
    });
  }, DOM_CAPTURE_INTERVAL_MS);
  captureVisibleMessagesFromAllTabs().catch(() => {
    // Ignore startup capture errors.
  });
}

function stopVisibleMessageCaptureLoop() {
  if (domCaptureIntervalHandle) {
    clearInterval(domCaptureIntervalHandle);
    domCaptureIntervalHandle = null;
  }
  domCaptureInFlightTabs.clear();
}

function buildTabState(tabId) {
  const view = tabViews.get(tabId);
  if (!view) {
    return { tabId, title: "", url: "", loading: false, canGoBack: false, canGoForward: false };
  }
  const wc = view.webContents;
  const history = wc.navigationHistory;
  const canGoBack = history && typeof history.canGoBack === "function" ? history.canGoBack() : wc.canGoBack();
  const canGoForward = history && typeof history.canGoForward === "function" ? history.canGoForward() : wc.canGoForward();
  return {
    tabId,
    title: wc.getTitle(),
    url: wc.getURL(),
    loading: wc.isLoading(),
    canGoBack,
    canGoForward
  };
}

function broadcast(channel, payload) {
  if (mainWindow) {
    mainWindow.webContents.send(channel, payload);
  }
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve(null);
      return;
    }
    if (shuttingDownForQuit) {
      resolve(null);
      return;
    }
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve(null);
      return;
    }
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve([]);
      return;
    }
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function fireAndForgetDb(promise) {
  const tracked = Promise.resolve(promise)
    .catch((_error) => {
    // Keep app responsive even if DB writes fail.
    })
    .finally(() => {
      pendingDbWritePromises.delete(tracked);
    });
  pendingDbWritePromises.add(tracked);
}

async function waitForPendingDbWrites(timeoutMs) {
  const startedMs = Date.now();
  while (pendingDbWritePromises.size > 0 && Date.now() - startedMs < timeoutMs) {
    const snapshot = Array.from(pendingDbWritePromises);
    await Promise.race([
      Promise.allSettled(snapshot),
      sleep(100)
    ]);
  }
}

async function closeDatabase() {
  if (!db) {
    return;
  }
  const instance = db;
  db = null;
  await new Promise((resolve) => {
    instance.close(() => {
      resolve();
    });
  });
}

async function prepareForQuit() {
  if (quitCleanupCompleted) {
    return;
  }
  if (quitCleanupPromise) {
    await quitCleanupPromise;
    return;
  }
  quitCleanupPromise = (async () => {
    shuttingDownForQuit = true;
    stopVisibleMessageCaptureLoop();
    await waitForPendingDbWrites(6000);
    await closeDatabase();
    quitCleanupCompleted = true;
  })();
  try {
    await quitCleanupPromise;
  } finally {
    quitCleanupPromise = null;
  }
}

async function initDatabase() {
  if (!sqlite3) {
    dbReady = false;
    dbError = "sqlite3 dependency is not installed. Run npm install.";
    return;
  }

  dbPath = path.join(app.getPath("userData"), "commmefasterd.sqlite");
  db = await new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(instance);
    });
  });

  await dbRun("PRAGMA journal_mode = WAL");
  await dbRun("PRAGMA foreign_keys = ON");

  await dbRun(`CREATE TABLE IF NOT EXISTS llm_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    api_key TEXT,
    model TEXT,
    endpoint_override TEXT,
    updated_at TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    instructions TEXT NOT NULL,
    schedule_text TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    generated_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_tab TEXT NOT NULL,
    match_text TEXT NOT NULL,
    schedule_text TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    action_ids_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    generated_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS trigger_evaluations (
    id TEXT PRIMARY KEY,
    trigger_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    matched INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS automation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS console_logs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    message TEXT NOT NULL,
    source_id TEXT,
    line INTEGER
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS http_traffic (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    status_code INTEGER,
    status_line TEXT,
    from_cache INTEGER NOT NULL,
    ip TEXT,
    duration_ms INTEGER,
    error TEXT
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL
  )`);

  dbReady = true;
  dbError = "";
}

async function loadStateFromDb() {
  if (!dbReady) {
    return;
  }

  const settingsRow = await dbGet("SELECT provider, api_key, model, endpoint_override FROM llm_settings WHERE id = 1");
  if (settingsRow) {
    llmSettings = {
      provider: settingsRow.provider || "openai",
      apiKey: settingsRow.api_key || "",
      model: settingsRow.model || "",
      endpointOverride: settingsRow.endpoint_override || ""
    };
  }

  const actionRows = await dbAll("SELECT * FROM actions ORDER BY created_at DESC");
  actionRows.forEach((row) => {
    const action = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      instructions: row.instructions,
      scheduleText: row.schedule_text,
      schedule: JSON.parse(row.schedule_json),
      enabled: Boolean(row.enabled),
      generatedCode: row.generated_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    actions.set(action.id, action);
  });

  const triggerRows = await dbAll("SELECT * FROM triggers ORDER BY created_at DESC");
  triggerRows.forEach((row) => {
    const trigger = {
      id: row.id,
      name: row.name,
      sourceTab: row.source_tab,
      matchText: row.match_text,
      scheduleText: row.schedule_text,
      schedule: JSON.parse(row.schedule_json),
      actionIds: JSON.parse(row.action_ids_json),
      enabled: Boolean(row.enabled),
      generatedCode: row.generated_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    triggers.set(trigger.id, trigger);
  });

  const messageRows = await dbAll("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?", [MAX_MESSAGES]);
  messageRows.forEach((row) => {
    const hydrated = {
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      source: row.source,
      title: row.title,
      body: row.body
    };
    messageHistory.push(hydrated);
    if (String(hydrated.source || "").startsWith("dom-")) {
      rememberDomMessageKey(
        buildDomMessageDedupKey(hydrated.tabId, {
          source: hydrated.source,
          key: `${hydrated.title}|${hydrated.body.slice(0, 180)}`
        })
      );
    }
  });

  const evalRows = await dbAll("SELECT * FROM trigger_evaluations ORDER BY created_at DESC LIMIT ?", [MAX_EVALUATIONS]);
  evalRows.forEach((row) => {
    triggerEvaluations.push({
      id: row.id,
      triggerId: row.trigger_id,
      messageId: row.message_id,
      matched: Boolean(row.matched),
      reason: row.reason,
      createdAt: row.created_at
    });
  });

  const eventRows = await dbAll("SELECT created_at, kind, payload_json FROM automation_events ORDER BY id DESC LIMIT ?", [MAX_EVENTS]);
  eventRows.forEach((row) => {
    const payload = JSON.parse(row.payload_json || "{}");
    automationEvents.push({
      createdAt: row.created_at,
      kind: row.kind,
      ...payload
    });
  });

  const consoleRows = await dbAll(
    "SELECT id, created_at, tab_id, level, message, source_id, line FROM console_logs ORDER BY created_at DESC LIMIT ?",
    [MAX_CONSOLE_LOGS]
  );
  consoleRows.forEach((row) => {
    consoleLogs.push({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      level: row.level,
      message: row.message,
      sourceId: row.source_id || "",
      line: row.line || 0
    });
  });

  const httpRows = await dbAll(
    "SELECT id, created_at, tab_id, method, url, resource_type, status_code, status_line, from_cache, ip, duration_ms, error FROM http_traffic ORDER BY created_at DESC LIMIT ?",
    [MAX_HTTP_TRAFFIC]
  );
  httpRows.forEach((row) => {
    httpTraffic.push({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      method: row.method,
      url: row.url,
      resourceType: row.resource_type,
      statusCode: row.status_code || 0,
      statusLine: row.status_line || "",
      fromCache: Boolean(row.from_cache),
      ip: row.ip || "",
      durationMs: row.duration_ms || null,
      error: row.error || ""
    });
  });

  const screenshotRows = await dbAll(
    "SELECT id, created_at, tab_id, file_path, width, height FROM screenshots ORDER BY created_at DESC LIMIT ?",
    [MAX_SCREENSHOTS]
  );
  screenshotRows.forEach((row) => {
    screenshotHistory.push({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      filePath: row.file_path,
      width: row.width,
      height: row.height
    });
  });
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
    "  const { message, trigger } = context;",
    "  const prompt = [",
    `    "Action kind: " + ${actionKindLiteral},`,
    `    "Instructions: " + ${instructionsLiteral},`,
    "    \"Message title: \" + (message.title || \"\"),",
    "    \"Message body: \" + (message.body || \"\")",
    "  ].join(\"\\n\");",
    "",
    "  return {",
    "    status: 'planned',",
    "    prompt,",
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
        ? data.output.flatMap((item) => item.content || []).map((x) => x.text || "").join("\n")
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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

function upsertLlmSettings() {
  fireAndForgetDb(
    dbRun(
      `INSERT INTO llm_settings (id, provider, api_key, model, endpoint_override, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         api_key = excluded.api_key,
         model = excluded.model,
         endpoint_override = excluded.endpoint_override,
         updated_at = excluded.updated_at`,
      [llmSettings.provider, llmSettings.apiKey, llmSettings.model, llmSettings.endpointOverride, nowIso()]
    )
  );
}

function upsertAction(action) {
  fireAndForgetDb(
    dbRun(
      `INSERT INTO actions (id, name, kind, instructions, schedule_text, schedule_json, enabled, generated_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         instructions = excluded.instructions,
         schedule_text = excluded.schedule_text,
         schedule_json = excluded.schedule_json,
         enabled = excluded.enabled,
         generated_code = excluded.generated_code,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [
        action.id,
        action.name,
        action.kind,
        action.instructions,
        action.scheduleText,
        JSON.stringify(action.schedule),
        action.enabled ? 1 : 0,
        action.generatedCode,
        action.createdAt,
        action.updatedAt
      ]
    )
  );
}

function upsertTrigger(trigger) {
  fireAndForgetDb(
    dbRun(
      `INSERT INTO triggers (id, name, source_tab, match_text, schedule_text, schedule_json, action_ids_json, enabled, generated_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         source_tab = excluded.source_tab,
         match_text = excluded.match_text,
         schedule_text = excluded.schedule_text,
         schedule_json = excluded.schedule_json,
         action_ids_json = excluded.action_ids_json,
         enabled = excluded.enabled,
         generated_code = excluded.generated_code,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [
        trigger.id,
        trigger.name,
        trigger.sourceTab,
        trigger.matchText,
        trigger.scheduleText,
        JSON.stringify(trigger.schedule),
        JSON.stringify(trigger.actionIds),
        trigger.enabled ? 1 : 0,
        trigger.generatedCode,
        trigger.createdAt,
        trigger.updatedAt
      ]
    )
  );
}

function insertAppEvent(tabId, eventType, payload) {
  fireAndForgetDb(
    dbRun(
      `INSERT INTO app_events (created_at, tab_id, event_type, payload_json) VALUES (?, ?, ?, ?)`,
      [nowIso(), tabId, eventType, JSON.stringify(payload || {})]
    )
  );
}

function pushConsoleLog(entry) {
  consoleLogs.unshift(entry);
  trimArraySize(consoleLogs, MAX_CONSOLE_LOGS);
  fireAndForgetDb(
    dbRun(
      `INSERT INTO console_logs (id, created_at, tab_id, level, message, source_id, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.createdAt, entry.tabId, entry.level, entry.message, entry.sourceId || "", entry.line || 0]
    )
  );
}

function pushHttpTraffic(entry) {
  httpTraffic.unshift(entry);
  trimArraySize(httpTraffic, MAX_HTTP_TRAFFIC);
  fireAndForgetDb(
    dbRun(
      `INSERT INTO http_traffic (id, created_at, tab_id, method, url, resource_type, status_code, status_line, from_cache, ip, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.createdAt,
        entry.tabId,
        entry.method || "",
        entry.url || "",
        entry.resourceType || "unknown",
        entry.statusCode || 0,
        entry.statusLine || "",
        entry.fromCache ? 1 : 0,
        entry.ip || "",
        Number.isFinite(entry.durationMs) ? entry.durationMs : null,
        entry.error || ""
      ]
    )
  );
}

function pushScreenshotMeta(entry) {
  screenshotHistory.unshift(entry);
  trimArraySize(screenshotHistory, MAX_SCREENSHOTS);
  fireAndForgetDb(
    dbRun(
      `INSERT INTO screenshots (id, created_at, tab_id, file_path, width, height) VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.createdAt, entry.tabId, entry.filePath, entry.width, entry.height]
    )
  );
}

function installNetworkObserversForSession(sess) {
  if (!sess || networkObserversInstalled) {
    return;
  }
  networkObserversInstalled = true;

  sess.webRequest.onBeforeRequest((details, callback) => {
    pendingNetworkRequests.set(details.id, {
      startedAtMs: Date.now(),
      tabId: webContentsToTabId.get(details.webContentsId) || "unknown",
      method: details.method || "",
      resourceType: details.resourceType || "unknown"
    });
    callback({});
  });

  sess.webRequest.onCompleted((details) => {
    const start = pendingNetworkRequests.get(details.id);
    pendingNetworkRequests.delete(details.id);
    pushHttpTraffic({
      id: newId("http"),
      createdAt: nowIso(),
      tabId: webContentsToTabId.get(details.webContentsId) || (start && start.tabId) || "unknown",
      method: details.method || (start && start.method) || "",
      url: details.url || "",
      resourceType: details.resourceType || (start && start.resourceType) || "unknown",
      statusCode: details.statusCode || 0,
      statusLine: details.statusLine || "",
      fromCache: Boolean(details.fromCache),
      ip: details.ip || "",
      durationMs: start ? Math.max(0, Date.now() - start.startedAtMs) : null,
      error: ""
    });
  });

  sess.webRequest.onErrorOccurred((details) => {
    const start = pendingNetworkRequests.get(details.id);
    pendingNetworkRequests.delete(details.id);
    pushHttpTraffic({
      id: newId("http"),
      createdAt: nowIso(),
      tabId: webContentsToTabId.get(details.webContentsId) || (start && start.tabId) || "unknown",
      method: details.method || (start && start.method) || "",
      url: details.url || "",
      resourceType: details.resourceType || (start && start.resourceType) || "unknown",
      statusCode: 0,
      statusLine: "",
      fromCache: false,
      ip: "",
      durationMs: start ? Math.max(0, Date.now() - start.startedAtMs) : null,
      error: details.error || "unknown"
    });
  });
}

function listConsoleLogs(tabId, limit) {
  const max = Math.max(1, Math.min(1000, Number(limit) || 200));
  const rows = tabId ? consoleLogs.filter((item) => item.tabId === tabId) : consoleLogs;
  return rows.slice(0, max);
}

function listHttpTraffic(tabId, limit) {
  const max = Math.max(1, Math.min(1000, Number(limit) || 400));
  const rows = tabId ? httpTraffic.filter((item) => item.tabId === tabId) : httpTraffic;
  return rows.slice(0, max);
}

function listScreenshots(tabId, limit) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = tabId ? screenshotHistory.filter((item) => item.tabId === tabId) : screenshotHistory;
  return rows.slice(0, max);
}

function pushAutomationEvent(event) {
  const decorated = { ...event, createdAt: nowIso() };
  automationEvents.unshift(decorated);
  trimArraySize(automationEvents, MAX_EVENTS);
  broadcast("automation:event", decorated);
  fireAndForgetDb(
    dbRun(`INSERT INTO automation_events (created_at, kind, payload_json) VALUES (?, ?, ?)`, [
      decorated.createdAt,
      decorated.kind,
      JSON.stringify(decorated)
    ])
  );
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
  fireAndForgetDb(
    dbRun(
      `INSERT INTO messages (id, created_at, tab_id, source, title, body, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [message.id, message.createdAt, message.tabId, message.source, message.title, message.body, JSON.stringify(message)]
    )
  );
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
    fireAndForgetDb(
      dbRun(
        `INSERT INTO trigger_evaluations (id, trigger_id, message_id, matched, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [evaluation.id, evaluation.triggerId, evaluation.messageId, evaluation.matched ? 1 : 0, evaluation.reason, evaluation.createdAt]
      )
    );

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
}

function getTriggerApplicationHistory(triggerId) {
  if (!triggers.has(triggerId)) {
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

async function databaseOverview() {
  if (!dbReady) {
    return {
      ok: false,
      dbPath,
      error: dbError || "Database not ready."
    };
  }

  const counts = {};
  for (const table of DB_TABLES) {
    const row = await dbGet(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = row ? row.count : 0;
  }

  const recentAppEvents = await dbAll(
    `SELECT id, created_at, tab_id, event_type, payload_json FROM app_events ORDER BY id DESC LIMIT 20`
  );
  const recentMessages = await dbAll(
    `SELECT id, created_at, tab_id, source, title, body FROM messages ORDER BY created_at DESC LIMIT 20`
  );
  const recentConsoleLogs = await dbAll(
    `SELECT id, created_at, tab_id, level, message, source_id, line FROM console_logs ORDER BY created_at DESC LIMIT 40`
  );
  const recentHttpTraffic = await dbAll(
    `SELECT id, created_at, tab_id, method, url, resource_type, status_code, from_cache, duration_ms, error FROM http_traffic ORDER BY created_at DESC LIMIT 40`
  );
  const recentScreenshots = await dbAll(
    `SELECT id, created_at, tab_id, file_path, width, height FROM screenshots ORDER BY created_at DESC LIMIT 20`
  );

  return {
    ok: true,
    dbPath,
    tables: DB_TABLES.slice(),
    counts,
    recentAppEvents: recentAppEvents.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json || "{}")
    })),
    recentMessages: recentMessages.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      source: row.source,
      title: row.title,
      body: row.body
    })),
    recentConsoleLogs: recentConsoleLogs.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      level: row.level,
      message: row.message,
      sourceId: row.source_id || "",
      line: row.line || 0
    })),
    recentHttpTraffic: recentHttpTraffic.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      method: row.method,
      url: row.url,
      resourceType: row.resource_type,
      statusCode: row.status_code || 0,
      fromCache: Boolean(row.from_cache),
      durationMs: row.duration_ms || null,
      error: row.error || ""
    })),
    recentScreenshots: recentScreenshots.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      tabId: row.tab_id,
      filePath: row.file_path,
      width: row.width,
      height: row.height
    }))
  };
}

function isKnownDbTable(table) {
  return DB_TABLES.includes(table);
}

async function databaseTableRows(table, limit) {
  if (!dbReady) {
    return { ok: false, error: dbError || "Database not ready." };
  }
  if (!isKnownDbTable(table)) {
    return { ok: false, error: `Unknown table "${table}".` };
  }

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const orderBy = DB_TABLE_SORT[table] || "rowid DESC";
  try {
    const rows = await dbAll(`SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ?`, [safeLimit]);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      ok: true,
      table,
      limit: safeLimit,
      columns,
      rows
    };
  } catch (error) {
    return { ok: false, error: error.message || "Failed loading table rows." };
  }
}

function isReadOnlySql(sql) {
  const trimmed = sql.trim().toLowerCase();
  return /^(select|with|pragma|explain)\b/.test(trimmed);
}

async function runDatabaseQuery(sql) {
  if (!dbReady) {
    return { ok: false, error: dbError || "Database not ready." };
  }
  if (!sql || !sql.trim()) {
    return { ok: false, error: "Query is empty." };
  }
  if (!isReadOnlySql(sql)) {
    return { ok: false, error: "Only read-only queries are allowed (SELECT/WITH/PRAGMA/EXPLAIN)." };
  }

  try {
    const rows = await dbAll(sql);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { ok: true, columns, rows };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to execute query." };
  }
}

async function captureScreenshotForTab(requestedTabId) {
  const tabId = requestedTabId || activeTabId;
  const selectedTab = TABS.find((tab) => tab.id === tabId);
  if (!selectedTab || selectedTab.type !== "web") {
    return { ok: false, error: "Screenshot requires a web tab (Slack/Teams/Office/Gmail/Calendar)." };
  }
  const view = tabViews.get(tabId);
  if (!view) {
    return { ok: false, error: `Tab "${tabId}" is not available.` };
  }

  try {
    const image = await view.webContents.capturePage();
    const buffer = image.toPNG();
    const size = image.getSize();
    const createdAt = nowIso();
    const fileName = `${tabId}-${createdAt.replace(/[:.]/g, "-")}.png`;
    const filePath = path.join(screenshotsDir, fileName);
    fs.writeFileSync(filePath, buffer);

    const meta = {
      id: newId("shot"),
      createdAt,
      tabId,
      filePath,
      width: size.width,
      height: size.height
    };
    pushScreenshotMeta(meta);

    return {
      ok: true,
      screenshot: meta,
      dataUrl: `data:image/png;base64,${buffer.toString("base64")}`
    };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to capture screenshot." };
  }
}

function attachViewObservers(tabId, view) {
  const emitState = () => {
    broadcast("tab:state", buildTabState(tabId));
  };
  const wc = view.webContents;

  wc.on("did-start-loading", () => {
    emitState();
    insertAppEvent(tabId, "did-start-loading", { url: wc.getURL() });
  });
  wc.on("did-stop-loading", () => {
    emitState();
    insertAppEvent(tabId, "did-stop-loading", { url: wc.getURL(), title: wc.getTitle() });
    requestVisibleMessageCapture(tabId);
  });
  wc.on("did-navigate", (_event, url) => {
    emitState();
    insertAppEvent(tabId, "did-navigate", { url });
    requestVisibleMessageCapture(tabId);
  });
  wc.on("did-navigate-in-page", (_event, url) => {
    emitState();
    insertAppEvent(tabId, "did-navigate-in-page", { url });
    requestVisibleMessageCapture(tabId);
  });
  wc.on("page-title-updated", (_event, title) => {
    emitState();
    insertAppEvent(tabId, "page-title-updated", { title });
  });
  wc.on("console-message", (_event, ...args) => {
    let level = 0;
    let message = "";
    let sourceId = "";
    let line = 0;
    if (args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      const payload = args[0];
      level = typeof payload.level === "number" ? payload.level : 0;
      message = typeof payload.message === "string" ? payload.message : "";
      sourceId = typeof payload.sourceId === "string" ? payload.sourceId : "";
      line = typeof payload.lineNumber === "number" ? payload.lineNumber : 0;
    } else {
      level = typeof args[0] === "number" ? args[0] : 0;
      message = typeof args[1] === "string" ? args[1] : "";
      line = typeof args[2] === "number" ? args[2] : 0;
      sourceId = typeof args[3] === "string" ? args[3] : "";
    }
    pushConsoleLog({
      id: newId("console"),
      createdAt: nowIso(),
      tabId,
      level,
      message,
      sourceId,
      line
    });
  });
  wc.on("notification-shown", (_event, notification) => {
    const payload = { title: notification.title || "", body: notification.body || "", source: "notification" };
    insertAppEvent(tabId, "notification-shown", payload);
    runTriggerPipeline(tabId, payload);
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
  const wcId = view.webContents.id;
  webContentsToTabId.set(wcId, tab.id);
  if (!shouldRunCaptureAutorun()) {
    installNetworkObserversForSession(view.webContents.session);
  }
  view.webContents.on("destroyed", () => {
    webContentsToTabId.delete(wcId);
  });
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
  requestVisibleMessageCapture(tabId);
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
    upsertLlmSettings();
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
    upsertAction(action);
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
    upsertAction(action);
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
    upsertTrigger(trigger);
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
    upsertTrigger(trigger);
    return { ok: true };
  });

  ipcMain.handle("automation:simulate-message", (_event, payload) => {
    insertAppEvent(payload.tabId || "unknown", "simulated-message", { title: payload.title || "", body: payload.body || "" });
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
  ipcMain.handle("automation:trigger-history", (_event, payload) =>
    getTriggerApplicationHistory((payload && payload.triggerId) || "")
  );
  ipcMain.handle("automation:inspect-schedule", (_event, payload) =>
    inspectSchedule((payload && payload.atIso) || nowIso())
  );

  ipcMain.handle("diagnostics:list-console", (_event, payload) =>
    listConsoleLogs((payload && payload.tabId) || "", (payload && payload.limit) || 200)
  );
  ipcMain.handle("diagnostics:list-http", (_event, payload) =>
    listHttpTraffic((payload && payload.tabId) || "", (payload && payload.limit) || 400)
  );
  ipcMain.handle("diagnostics:list-screenshots", (_event, payload) =>
    listScreenshots((payload && payload.tabId) || "", (payload && payload.limit) || 50)
  );
  ipcMain.handle("diagnostics:capture-screenshot", async (_event, payload) =>
    captureScreenshotForTab((payload && payload.tabId) || "")
  );
  ipcMain.handle("diagnostics:run-outlook-capture-automation", async () =>
    runOutlookCaptureAutomation("manual")
  );
  ipcMain.handle("diagnostics:get-last-outlook-capture-automation", async () =>
    getLastOutlookAutomationRun()
  );
  ipcMain.handle("diagnostics:run-teams-capture-automation", async () =>
    runTeamsCaptureAutomation("manual")
  );
  ipcMain.handle("diagnostics:get-last-teams-capture-automation", async () =>
    getLastTeamsAutomationRun()
  );

  ipcMain.handle("database:overview", async () => databaseOverview());
  ipcMain.handle("database:table-rows", async (_event, payload) =>
    databaseTableRows((payload && payload.table) || "", (payload && payload.limit) || 50)
  );
  ipcMain.handle("database:query", async (_event, payload) => runDatabaseQuery((payload && payload.sql) || ""));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    title: "CommMeFasterd",
    icon: APP_ICON_PATH,
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
  if (!shouldRunCaptureAutorun()) {
    startVisibleMessageCaptureLoop();
  }
  mainWindow.on("resize", setViewBounds);
  mainWindow.on("closed", () => {
    stopVisibleMessageCaptureLoop();
    mainWindow = null;
  });
  switchToTab(activeTabId);
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(APP_ICON_PATH);
  }

  try {
    screenshotsDir = path.join(app.getPath("userData"), "screenshots");
    fs.mkdirSync(screenshotsDir, { recursive: true });
    diagnosticsDir = path.join(app.getPath("userData"), "diagnostics");
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    await initDatabase();
    await loadStateFromDb();
  } catch (error) {
    dbReady = false;
    dbError = error.message || "Database initialization failed.";
  }

  wireIpcHandlers();
  createMainWindow();

  const shouldRunOutlook = shouldAutoRunOutlookAutomation();
  const shouldRunTeams = shouldAutoRunTeamsAutomation();
  if (shouldRunOutlook || shouldRunTeams) {
    if (shouldRunOutlook) {
      const run = await runOutlookCaptureAutomation("autorun");
      console.log(`[outlook-capture-automation] status=${run.status} log=${run.logPath || "(none)"}`);
    }
    if (shouldRunTeams) {
      const run = await runTeamsCaptureAutomation("autorun");
      console.log(`[teams-capture-automation] status=${run.status} log=${run.logPath || "(none)"}`);
    }
    await prepareForQuit();
    setTimeout(() => {
      app.quit();
    }, 50);
  }
});

app.on("before-quit", (event) => {
  if (quitCleanupCompleted) {
    return;
  }
  event.preventDefault();
  void prepareForQuit()
    .catch((error) => {
      console.error(`[shutdown] cleanup failed: ${error.message || String(error)}`);
    })
    .finally(() => {
      app.quit();
    });
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
