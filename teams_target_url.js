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
  const path = String(parsed.pathname || "").toLowerCase();

  if (host === "teams.microsoft.com") {
    if (path.startsWith("/error/")) {
      return fallback;
    }
    if (path === "/" || path === "") {
      return fallback;
    }
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
