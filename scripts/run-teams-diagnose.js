const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { diagnosticsDir, runCaptureAutomation, userDataDir } = require("./capture-automation-runner");

const repoRoot = path.resolve(__dirname, "..");
const autorunArg = "--teams-autorun";
const diagnosticsFileName = "teams-capture-last-run.json";

function nowIso() {
  return new Date().toISOString();
}

function toReportStamp(iso) {
  return iso.replace(/[:.]/g, "-");
}

function safeJsonParse(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row || null);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function compactMessageRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    tabId: row.tab_id,
    source: row.source,
    title: String(row.title || "").slice(0, 200),
    bodyPreview: String(row.body || "").replace(/\s+/g, " ").trim().slice(0, 240)
  };
}

function compactAppEventRow(row) {
  const payload = safeJsonParse(row.payload_json);
  return {
    id: row.id,
    createdAt: row.created_at,
    tabId: row.tab_id,
    eventType: row.event_type,
    payloadUrl: payload && typeof payload.url === "string" ? payload.url : "",
    payloadTitle: payload && typeof payload.title === "string" ? payload.title.slice(0, 180) : "",
    payloadSummary: payload
      ? JSON.stringify(payload).slice(0, 300)
      : String(row.payload_json || "").slice(0, 300)
  };
}

function compactConsoleRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    level: row.level,
    message: String(row.message || "").slice(0, 300),
    sourceId: row.source_id || "",
    line: row.line || null
  };
}

function compactHttpRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    method: row.method,
    url: row.url,
    resourceType: row.resource_type,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    error: row.error || ""
  };
}

async function collectDatabaseEvidence(dbPath) {
  const evidence = {
    dbPath,
    dbExists: fs.existsSync(dbPath),
    counts: {},
    recentTeamsMessages: [],
    recentTeamsEvents: [],
    recentTeamsConsoleLogs: [],
    recentTeamsHttpTraffic: [],
    teamsSourceCounts: [],
    errors: []
  };
  if (!evidence.dbExists) {
    evidence.errors.push(`Database file not found at ${dbPath}`);
    return evidence;
  }

  let db = null;
  try {
    db = await openDb(dbPath);
    const teamsMessages = await dbGet(
      db,
      "SELECT COUNT(*) AS count FROM messages WHERE tab_id = 'teams'"
    );
    const teamsLikeMessages = await dbGet(
      db,
      "SELECT COUNT(*) AS count FROM messages WHERE tab_id = 'teams' AND (LOWER(source) LIKE '%dom-teams%' OR LOWER(source) LIKE '%teams.microsoft.com%')"
    );
    const recentTeamsMessages = await dbAll(
      db,
      "SELECT id, created_at, tab_id, source, title, body FROM messages WHERE tab_id = 'teams' ORDER BY created_at DESC LIMIT 50"
    );
    const recentTeamsEvents = await dbAll(
      db,
      "SELECT id, created_at, tab_id, event_type, payload_json FROM app_events WHERE tab_id = 'teams' ORDER BY id DESC LIMIT 80"
    );
    const recentTeamsConsoleLogs = await dbAll(
      db,
      "SELECT id, created_at, level, message, source_id, line FROM console_logs WHERE tab_id = 'teams' ORDER BY created_at DESC LIMIT 80"
    );
    const recentTeamsHttpTraffic = await dbAll(
      db,
      "SELECT id, created_at, method, url, resource_type, status_code, duration_ms, error FROM http_traffic WHERE tab_id = 'teams' ORDER BY created_at DESC LIMIT 100"
    );
    const teamsSourceCounts = await dbAll(
      db,
      "SELECT source, COUNT(*) AS count FROM messages WHERE tab_id = 'teams' GROUP BY source ORDER BY count DESC LIMIT 40"
    );

    evidence.counts = {
      teamsMessages: Number((teamsMessages && teamsMessages.count) || 0),
      teamsLikeMessages: Number((teamsLikeMessages && teamsLikeMessages.count) || 0)
    };
    evidence.recentTeamsMessages = recentTeamsMessages.map(compactMessageRow);
    evidence.recentTeamsEvents = recentTeamsEvents.map(compactAppEventRow);
    evidence.recentTeamsConsoleLogs = recentTeamsConsoleLogs.map(compactConsoleRow);
    evidence.recentTeamsHttpTraffic = recentTeamsHttpTraffic.map(compactHttpRow);
    evidence.teamsSourceCounts = teamsSourceCounts.map((row) => ({
      source: row.source,
      count: Number(row.count || 0)
    }));
  } catch (error) {
    evidence.errors.push(error.message || "Failed collecting DB evidence");
  } finally {
    if (db) {
      try {
        await closeDb(db);
      } catch (error) {
        evidence.errors.push(error.message || "Failed closing DB");
      }
    }
  }
  return evidence;
}

function determineVerdict(automationRun, dbEvidence) {
  const insertedTotal = Number((automationRun && automationRun.summary && automationRun.summary.insertedTotal) || 0);
  const delta = Number((automationRun && automationRun.summary && automationRun.summary.delta) || 0);
  const statusPassed = automationRun && automationRun.status === "passed";
  const hasTeamsRows = Number((dbEvidence.counts && dbEvidence.counts.teamsMessages) || 0) > 0;
  const insertedThisRun = insertedTotal > 0 || delta > 0;
  return {
    statusPassed: Boolean(statusPassed),
    insertedThisRun,
    hasTeamsRows,
    pass: Boolean(statusPassed && insertedThisRun && hasTeamsRows)
  };
}

function writableDiagnosticsDir() {
  const preferred = diagnosticsDir();
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probePath = path.join(preferred, ".write-test");
    fs.writeFileSync(probePath, "ok");
    fs.unlinkSync(probePath);
    return preferred;
  } catch (_error) {
    const fallback = path.join("/tmp", "comm-me-fasterd-diagnostics");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

async function main() {
  const startedAt = nowIso();
  const result = await runCaptureAutomation({
    repoRoot,
    autorunArg,
    diagnosticsFileName
  });
  const automationRun = result.run;
  let lastKnownAutomationRun = null;
  if (result.logPath && fs.existsSync(result.logPath)) {
    try {
      lastKnownAutomationRun = JSON.parse(fs.readFileSync(result.logPath, "utf8"));
    } catch (_error) {
      lastKnownAutomationRun = null;
    }
  }
  const dbPath = path.join(userDataDir(), "commmefasterd.sqlite");
  const dbEvidence = await collectDatabaseEvidence(dbPath);
  const verdict = determineVerdict(automationRun, dbEvidence);
  const finishedAt = nowIso();

  const report = {
    kind: "teams-capture-diagnostics",
    startedAt,
    completedAt: finishedAt,
    launcher: result.launcher || "",
    launchErrors: result.errors || [],
    automationRunFound: Boolean(automationRun),
    automationLogPath: result.logPath || "",
    automationRun,
    lastKnownAutomationRun,
    dbEvidence,
    verdict
  };

  const diagnosticsPath = writableDiagnosticsDir();
  const stamp = toReportStamp(finishedAt);
  const reportPath = path.join(diagnosticsPath, `teams-capture-debug-report-${stamp}.json`);
  const lastReportPath = path.join(diagnosticsPath, "teams-capture-debug-last-report.json");
  const body = JSON.stringify(report, null, 2);
  fs.writeFileSync(reportPath, body);
  fs.writeFileSync(lastReportPath, body);

  console.log(`Teams diagnose status: ${verdict.pass ? "passed" : "failed"}`);
  console.log(`Teams automation status: ${automationRun ? automationRun.status : "missing-run-log"}`);
  console.log(`Teams automation launcher: ${result.launcher || "unknown"}`);
  console.log(`Teams automation log: ${(automationRun && (automationRun.logPath || automationRun.lastLogPath)) || result.logPath}`);
  console.log(`Teams debug report: ${reportPath}`);

  if (!automationRun) {
    process.exit(1);
    return;
  }
  process.exit(verdict.pass ? 0 : 2);
}

main().catch((error) => {
  console.error(`Failed to run Teams diagnose: ${error.message || String(error)}`);
  process.exit(1);
});
