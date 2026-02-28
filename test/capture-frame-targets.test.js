const test = require("node:test");
const assert = require("node:assert/strict");
const { collectCaptureFrameTargetsFromMainFrame } = require("../capture_frame_targets");

function makeFrame({ routingId, url = "", withExecute = true } = {}) {
  const frame = {
    routingId,
    url
  };
  if (withExecute) {
    frame.executeJavaScript = async () => ({ ok: true });
  }
  return frame;
}

test("includes Outlook content frames even when frame URL is about:blank", () => {
  const mainFrame = {
    framesInSubtree: [
      makeFrame({ routingId: 1, url: "https://www.office.com/" }),
      makeFrame({ routingId: 2, url: "about:blank" }),
      makeFrame({ routingId: 3, url: "" })
    ]
  };

  const targets = collectCaptureFrameTargetsFromMainFrame(mainFrame, 16);
  const urls = targets.map((frame) => frame.url);
  assert.deepEqual(urls, ["https://www.office.com/", "about:blank", ""]);
});

test("deduplicates repeated routing IDs", () => {
  const same = makeFrame({ routingId: 8, url: "https://outlook.office.com/mail/" });
  const dupe = makeFrame({ routingId: 8, url: "https://outlook.office.com/mail/" });
  const mainFrame = { framesInSubtree: [same, dupe] };

  const targets = collectCaptureFrameTargetsFromMainFrame(mainFrame, 16);
  assert.equal(targets.length, 1);
});
