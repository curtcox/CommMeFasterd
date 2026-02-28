function resolveTeamsWebUrl(currentUrl) {
  const fallback = "https://teams.microsoft.com/v2/";
  if (!currentUrl || typeof currentUrl !== "string") {
    return fallback;
  }

  let parsed = null;
  try {
    parsed = new URL(currentUrl);
  } catch (_error) {
    return fallback;
  }

  const host = String(parsed.hostname || "").toLowerCase();

  if (host === "teams.microsoft.com") {
    return currentUrl;
  }

  if (host === "teams.live.com" || host.endsWith(".teams.live.com")) {
    return fallback;
  }

  return fallback;
}

module.exports = {
  resolveTeamsWebUrl
};
