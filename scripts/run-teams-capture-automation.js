const path = require("path");
const { runCaptureAutomation } = require("./capture-automation-runner");

const repoRoot = path.resolve(__dirname, "..");
const autorunArg = "--teams-autorun";
const diagnosticsFileName = "teams-capture-last-run.json";

async function main() {
  const result = await runCaptureAutomation({
    repoRoot,
    autorunArg,
    diagnosticsFileName
  });
  if (!result.run) {
    console.error(`Timed out waiting for Teams automation run log update at ${result.logPath}`);
    if (result.errors.length > 0) {
      console.error(`Launch attempts: ${result.errors.join(" | ")}`);
    }
    process.exit(1);
    return;
  }

  const run = result.run;
  console.log(`Teams automation status: ${run.status}`);
  console.log(`Teams automation started: ${run.startedAt}`);
  console.log(`Teams automation completed: ${run.completedAt}`);
  console.log(`Teams automation launcher: ${result.launcher || "unknown"}`);
  console.log(`Teams automation log: ${run.logPath || result.logPath}`);
  process.exit(run.status === "passed" ? 0 : 2);
}

main().catch((error) => {
  console.error(`Failed to run Teams automation: ${error.message || String(error)}`);
  process.exit(1);
});
