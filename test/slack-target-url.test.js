const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSlackClientUrl } = require("../slack_target_url");

test("routes slack marketing URLs to app client", () => {
  const url = "https://slack.com/signin#/signin";
  assert.equal(resolveSlackClientUrl(url), "https://app.slack.com/client");
});

test("keeps existing app client URLs", () => {
  const url = "https://app.slack.com/client/T0123ABC4/C0567DEF8";
  assert.equal(resolveSlackClientUrl(url), url);
});

test("routes workspace subdomain URLs to app client", () => {
  const url = "https://myworkspace.slack.com/messages/general";
  assert.equal(resolveSlackClientUrl(url), "https://app.slack.com/client");
});
