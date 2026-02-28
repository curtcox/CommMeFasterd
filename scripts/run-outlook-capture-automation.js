const path = require("path");
const { runCaptureAutomation } = require("./capture-automation-runner");

const repoRoot = path.resolve(__dirname, "..");
const autorunArg = "--outlook-autorun";
const diagnosticsFileName = "outlook-capture-last-run.json";

async function main() {
  const result = await runCaptureAutomation({
    repoRoot,
    autorunArg,
    diagnosticsFileName
  });
  if (!result.run) {
    console.error(`Timed out waiting for Outlook automation run log update at ${result.logPath}`);
    if (result.errors.length > 0) {
      console.error(`Launch attempts: ${result.errors.join(" | ")}`);
    }
    process.exit(1);
    return;
  }

  const run = result.run;
  console.log(`Outlook automation status: ${run.status}`);
  console.log(`Outlook automation started: ${run.startedAt}`);
  console.log(`Outlook automation completed: ${run.completedAt}`);
  console.log(`Outlook automation launcher: ${result.launcher || "unknown"}`);
  console.log(`Outlook automation log: ${run.logPath || result.logPath}`);
  process.exit(run.status === "passed" ? 0 : 2);
}

main().catch((error) => {
  console.error(`Failed to run Outlook automation: ${error.message || String(error)}`);
  process.exit(1);
});
