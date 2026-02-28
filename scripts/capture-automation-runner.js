const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const electronBinary = require("electron");
const pkg = require("../package.json");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function userDataDir(overrideValue = "") {
  const override = String(overrideValue || process.env.COMMMEFASTERD_USER_DATA_DIR || "").trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", pkg.name);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, pkg.name);
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, pkg.name);
}

function diagnosticsDir(overrideValue = "") {
  return path.join(userDataDir(overrideValue), "diagnostics");
}

function lastRunLogPath(fileName, overrideValue = "") {
  return path.join(diagnosticsDir(overrideValue), fileName);
}

function electronAppBundlePath() {
  if (process.platform === "darwin") {
    return path.resolve(electronBinary, "..", "..", "..");
  }
  return "";
}

function launchUsingOpen(repoRoot, autorunArg, env) {
  const appBundle = electronAppBundlePath();
  if (!appBundle || !fs.existsSync(appBundle)) {
    throw new Error(`Unable to locate Electron.app bundle from ${electronBinary}`);
  }
  return spawn("open", ["-na", appBundle, "--args", repoRoot, autorunArg], {
    cwd: repoRoot,
    stdio: "inherit",
    env
  });
}

function launchUsingSpawn(repoRoot, autorunArg, env) {
  return spawn(electronBinary, [repoRoot, autorunArg], {
    cwd: repoRoot,
    stdio: "inherit",
    env
  });
}

function waitForChildExit(child, attemptName) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (typeof code === "number" && code !== 0) {
        reject(new Error(`${attemptName} launcher exited with code ${code}`));
        return;
      }
      if (signal) {
        reject(new Error(`${attemptName} launcher exited via signal ${signal}`));
        return;
      }
      resolve();
    });
  });
}

async function waitForNewRun(logPath, previousMtimeMs, maxWaitMs, pollIntervalMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.mtimeMs > previousMtimeMs) {
        try {
          return JSON.parse(fs.readFileSync(logPath, "utf8"));
        } catch (_error) {
          // File may still be writing.
        }
      }
    }
    await sleep(pollIntervalMs);
  }
  return null;
}

function launchAttempts(repoRoot, autorunArg, env) {
  const attempts = [{ name: "spawn", start: () => launchUsingSpawn(repoRoot, autorunArg, env) }];
  if (process.platform === "darwin") {
    attempts.push({ name: "open", start: () => launchUsingOpen(repoRoot, autorunArg, env) });
  }
  return attempts;
}

async function runCaptureAutomation(options) {
  const repoRoot = options.repoRoot;
  const autorunArg = options.autorunArg;
  const diagnosticsFileName = options.diagnosticsFileName;
  const maxWaitMs = Number(options.maxWaitMs || 180000);
  const pollIntervalMs = Number(options.pollIntervalMs || 1000);
  const userDataDirOverride = String(options.userDataDirOverride || "").trim();
  const childEnv = { ...process.env };
  if (userDataDirOverride) {
    childEnv.COMMMEFASTERD_USER_DATA_DIR = path.resolve(userDataDirOverride);
  }
  const logPath = lastRunLogPath(diagnosticsFileName, userDataDirOverride);
  const previousMtimeMs = fs.existsSync(logPath) ? fs.statSync(logPath).mtimeMs : 0;
  const attempts = launchAttempts(repoRoot, autorunArg, childEnv);
  const attemptErrors = [];
  const startedAtMs = Date.now();

  for (const attempt of attempts) {
    const elapsed = Date.now() - startedAtMs;
    const remainingWaitMs = maxWaitMs - elapsed;
    if (remainingWaitMs <= 0) {
      attemptErrors.push(`No wait budget remaining before ${attempt.name} attempt.`);
      break;
    }
    try {
      const child = attempt.start();
      await waitForChildExit(child, attempt.name);
      const run = await waitForNewRun(logPath, previousMtimeMs, remainingWaitMs, pollIntervalMs);
      if (run) {
        return {
          run,
          logPath,
          launcher: attempt.name,
          errors: attemptErrors
        };
      }
      attemptErrors.push(`${attempt.name} attempt finished but did not update ${logPath} within ${remainingWaitMs}ms.`);
    } catch (error) {
      attemptErrors.push(error.message || `Unknown ${attempt.name} launcher error`);
    }
  }

  return {
    run: null,
    logPath,
    launcher: "",
    errors: attemptErrors
  };
}

module.exports = {
  diagnosticsDir,
  lastRunLogPath,
  runCaptureAutomation,
  userDataDir
};
