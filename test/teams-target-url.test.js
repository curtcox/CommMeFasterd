const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTeamsWebUrl } = require("../teams_target_url");

test("routes Teams marketing/login URLs to Teams web app", () => {
  const url = "https://www.microsoft.com/en-us/microsoft-teams/log-in";
  assert.equal(resolveTeamsWebUrl(url), "https://teams.microsoft.com/v2/");
});

test("keeps existing Teams web app URLs", () => {
  const url = "https://teams.microsoft.com/v2/?tenantId=abc";
  assert.equal(resolveTeamsWebUrl(url), url);
});

test("routes teams.live.com URLs to Teams web app", () => {
  const url = "https://teams.live.com/_#/conversations/19:abc@thread.v2";
  assert.equal(resolveTeamsWebUrl(url), "https://teams.microsoft.com/v2/");
});
