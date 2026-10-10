import assert from "node:assert/strict";
import test from "node:test";
import { NOTES_LIMIT, UPDATE_FEED_FIELD, updateFeedUrl, updateNotes } from "./update-feed.mjs";

const FEED = "https://github.com/woodbeary/later-dog/releases/latest/download/";

test("a build without a baked feed or an override has no update feed", () => {
  assert.equal(updateFeedUrl(), null);
  assert.equal(updateFeedUrl({ env: {}, packageJson: { version: "0.3.3" } }), null);
  assert.equal(updateFeedUrl({ env: { LATERDOG_UPDATE_URL: "  " }, packageJson: { [UPDATE_FEED_FIELD]: " " } }), null);
});

test("the signed build's baked feed is used, and the environment overrides it", () => {
  assert.deepEqual(updateFeedUrl({ packageJson: { [UPDATE_FEED_FIELD]: FEED } }), { url: FEED, source: "build" });
  assert.deepEqual(
    updateFeedUrl({ env: { LATERDOG_UPDATE_URL: "https://updates.example.test/mac/" }, packageJson: { [UPDATE_FEED_FIELD]: FEED } }),
    { url: "https://updates.example.test/mac/", source: "environment" },
  );
});

test("plain http is allowed only for a loopback test feed from the environment", () => {
  for (const url of ["http://127.0.0.1:8123/", "http://localhost:8123/feed/", "http://[::1]:8123/"]) {
    assert.deepEqual(updateFeedUrl({ env: { LATERDOG_UPDATE_URL: url } }), { url, source: "environment" });
  }
  assert.match(updateFeedUrl({ packageJson: { [UPDATE_FEED_FIELD]: "http://127.0.0.1:8123/" } }).error, /HTTPS/);
  assert.match(updateFeedUrl({ env: { LATERDOG_UPDATE_URL: "http://updates.example.test/" } }).error, /HTTPS/);
  assert.match(updateFeedUrl({ env: { LATERDOG_UPDATE_URL: "http://127.0.0.1.example.test/" } }).error, /HTTPS/);
});

test("a feed with credentials or that is not a URL is refused", () => {
  assert.match(updateFeedUrl({ packageJson: { [UPDATE_FEED_FIELD]: "https://user:secret@updates.example.test/" } }).error, /without URL credentials/);
  assert.match(updateFeedUrl({ env: { LATERDOG_UPDATE_URL: "http://user@127.0.0.1:8123/" } }).error, /without URL credentials/);
  assert.match(updateFeedUrl({ packageJson: { [UPDATE_FEED_FIELD]: "not a url" } }).error, /not a URL/);
  assert.match(updateFeedUrl({ packageJson: { [UPDATE_FEED_FIELD]: "file:///Applications/" } }).error, /HTTPS/);
});

test("release notes arrive as plain text, capped", () => {
  assert.equal(updateNotes({ releaseNotes: "  ### Fixes\r\n- One  \n" }), "### Fixes\n- One");
  assert.equal(updateNotes({ releaseNotes: [{ version: "0.3.4", note: "- One" }, { note: null }, { version: "0.3.3", note: "- Two" }] }), "- One\n\n- Two");
  assert.equal(updateNotes({ releaseNotes: "   " }), undefined);
  assert.equal(updateNotes({ releaseNotes: 42 }), undefined);
  assert.equal(updateNotes({}), undefined);
  assert.equal(updateNotes(null), undefined);
  const long = updateNotes({ releaseNotes: "x".repeat(NOTES_LIMIT + 50) });
  assert.equal(long.length, NOTES_LIMIT + 1);
  assert.ok(long.endsWith("…"));
});
