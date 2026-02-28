function resolveSlackClientUrl(currentUrl) {
  const fallback = "https://app.slack.com/client";
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

  if (host === "app.slack.com") {
    if (path.startsWith("/client")) {
      return currentUrl;
    }
    return fallback;
  }

  if (host === "slack.com" || host.endsWith(".slack.com")) {
    return fallback;
  }

  return fallback;
}

module.exports = {
  resolveSlackClientUrl
};
