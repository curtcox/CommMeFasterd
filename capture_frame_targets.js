function collectCaptureFrameTargetsFromMainFrame(mainFrame, maxFrames) {
  if (!mainFrame) {
    return [];
  }

  const allFrames =
    Array.isArray(mainFrame.framesInSubtree) && mainFrame.framesInSubtree.length > 0
      ? mainFrame.framesInSubtree
      : [mainFrame];

  const targets = [];
  const seenRoutingIds = new Set();
  for (const frame of allFrames) {
    if (!frame || typeof frame.executeJavaScript !== "function") {
      continue;
    }
    const routingId = typeof frame.routingId === "number" ? frame.routingId : null;
    if (routingId !== null) {
      if (seenRoutingIds.has(routingId)) {
        continue;
      }
      seenRoutingIds.add(routingId);
    }
    const frameUrl = typeof frame.url === "string" ? frame.url : "";
    if (!isAllowedCaptureFrameUrl(frameUrl)) {
      continue;
    }
    targets.push(frame);
    if (targets.length >= maxFrames) {
      break;
    }
  }
  return targets;
}

function isAllowedCaptureFrameUrl(rawUrl) {
  const url = String(rawUrl || "").trim().toLowerCase();
  if (!url) {
    return true;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return true;
  }
  if (url === "about:blank" || url === "about:srcdoc") {
    return true;
  }
  if (url.startsWith("blob:")) {
    return true;
  }
  return false;
}

module.exports = {
  collectCaptureFrameTargetsFromMainFrame,
  isAllowedCaptureFrameUrl
};
