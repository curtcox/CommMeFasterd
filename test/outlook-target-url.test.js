const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveOutlookMailUrl } = require("../outlook_target_url");

test("routes m365 cloud chat pages to Outlook mail", () => {
  const url = "https://m365.cloud.microsoft/chat/?auth=2&origindomain=Office";
  assert.equal(resolveOutlookMailUrl(url), "https://outlook.office.com/mail/");
});

test("keeps existing Outlook mail URLs", () => {
  const url = "https://outlook.office.com/mail/inbox/id/AQMk...";
  assert.equal(resolveOutlookMailUrl(url), url);
});

test("uses gov cloud endpoint for office365.us", () => {
  const url = "https://outlook.office365.us/calendar/view/month";
  assert.equal(resolveOutlookMailUrl(url), "https://outlook.office365.us/mail/");
});
