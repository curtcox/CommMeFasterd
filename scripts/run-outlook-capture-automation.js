const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const electronBinary = require("electron");
const pkg = require("../package.json");

const repoRoot = path.resolve(__dirname, "..");
const autorunArg = "--outlook-autorun";
const maxWaitMs = 180000;
const pollIntervalMs = 1000;
const diagnosticsFileName = "outlook-capture-last-run.json";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function userDataDir() {
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

function lastRunLogPath() {
  return path.join(userDataDir(), "diagnostics", diagnosticsFileName);
}

function electronAppBundlePath() {
  if (process.platform === "darwin") {
    return path.resolve(electronBinary, "..", "..", "..");
  }
  return "";
}

function launchUsingOpen() {
  const appBundle = electronAppBundlePath();
  if (!appBundle || !fs.existsSync(appBundle)) {
    throw new Error(`Unable to locate Electron.app bundle from ${electronBinary}`);
  }

  return spawn("open", ["-na", appBundle, "--args", repoRoot, autorunArg], {
    cwd: repoRoot,
    stdio: "inherit"
  });
}

function launchUsingSpawn() {
  return spawn(electronBinary, [repoRoot, autorunArg], {
    cwd: repoRoot,
    stdio: "inherit"
  });
}

async function waitForNewRun(logPath, previousMtimeMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.mtimeMs > previousMtimeMs) {
        try {
          return JSON.parse(fs.readFileSync(logPath, "utf8"));
        } catch (_error) {
          // File may still be in-flight. Keep polling.
        }
      }
    }
    await sleep(pollIntervalMs);
  }
  return null;
}

async function main() {
  const logPath = lastRunLogPath();
  const previousMtimeMs = fs.existsSync(logPath) ? fs.statSync(logPath).mtimeMs : 0;

  let child = null;
  if (process.platform === "darwin") {
    child = launchUsingOpen();
  } else {
    child = launchUsingSpawn();
  }

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (typeof code === "number" && code !== 0) {
        reject(new Error(`Automation launcher exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const run = await waitForNewRun(logPath, previousMtimeMs);
  if (!run) {
    console.error(`Timed out waiting for automation run log update at ${logPath}`);
    process.exit(1);
    return;
  }

  console.log(`Outlook automation status: ${run.status}`);
  console.log(`Outlook automation started: ${run.startedAt}`);
  console.log(`Outlook automation completed: ${run.completedAt}`);
  console.log(`Outlook automation log: ${run.logPath || logPath}`);
  process.exit(run.status === "passed" ? 0 : 2);
}

main().catch((error) => {
  console.error(`Failed to run Outlook automation: ${error.message || String(error)}`);
  process.exit(1);
});
