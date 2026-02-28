function resolveOutlookMailUrl(currentUrl) {
  const fallback = "https://outlook.office.com/mail/";
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

  if (host.includes("outlook.office365.us")) {
    if (path.startsWith("/mail")) {
      return currentUrl;
    }
    return "https://outlook.office365.us/mail/";
  }

  if (host.includes("outlook.office.com")) {
    if (path.startsWith("/mail")) {
      return currentUrl;
    }
    return "https://outlook.office.com/mail/";
  }

  if (host.includes("outlook.live.com")) {
    if (path.startsWith("/mail")) {
      return currentUrl;
    }
    return "https://outlook.live.com/mail/";
  }

  return fallback;
}

module.exports = {
  resolveOutlookMailUrl
};
