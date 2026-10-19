import assert from "node:assert/strict";
import test from "node:test";

import { appLinkLogLabel, buildAppLink, parseAppLink } from "./app-link.mjs";

const accepted = [
  ["laterdog://dog/boat", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["laterdog-dev://dog/boat", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["LATERDOG://DOG/boat", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["laterdog://dog/boat/", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["laterdog://chat/boat", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["laterdog://chat/boat?thread=t-1", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["laterdog://thread/t-1?bot=boat", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
  ["laterdog://chat/g_team-2", "laterdog://dog/g_team-2", { kind: "dog", id: "g_team-2" }],
  ["laterdog://settings", "laterdog://settings", { kind: "settings", section: null }],
  ["laterdog://settings?section=usage", "laterdog://settings?section=usage", { kind: "settings", section: "usage" }],
  ["laterdog://settings/computer", "laterdog://settings?section=computer", { kind: "settings", section: "computer" }],
  ["laterdog://settings?section=passkeys", "laterdog://settings", { kind: "settings", section: null }],
  ["  laterdog://dog/boat  ", "laterdog://dog/boat", { kind: "dog", id: "boat" }],
];

test("dog, chat, thread and settings links parse to one canonical form", () => {
  for (const [raw, canonical, link] of accepted) {
    const parsed = parseAppLink(raw);
    assert.equal(parsed.ok, true, raw);
    assert.equal(parsed.canonical, canonical, raw);
    assert.deepEqual(parsed.link, link, raw);
  }
});

test("the chat form and the thread form open the same dog, without a thread", () => {
  const chat = parseAppLink("laterdog://chat/boat?thread=abc");
  const thread = parseAppLink("laterdog://thread/abc?bot=boat");
  assert.equal(chat.canonical, thread.canonical);
  assert.equal(JSON.stringify(chat).includes("abc"), false);
});

test("built links parse back to themselves", () => {
  for (const link of [{ kind: "dog", id: "boat" }, { kind: "settings", section: null }, { kind: "settings", section: "updates" }]) {
    const built = buildAppLink(link);
    const parsed = parseAppLink(built);
    assert.deepEqual(parsed, { ok: true, link, canonical: built });
  }
  assert.equal(buildAppLink({ kind: "dog", id: "boat" }, "laterdog-dev"), "laterdog-dev://dog/boat");
});

const refused = [
  [undefined, "malformed"],
  [42, "malformed"],
  ["", "malformed"],
  ["not a link", "malformed"],
  [`laterdog://dog/${"a".repeat(2050)}`, "malformed"],
  ["laterdog://dog/bo at", "malformed"],
  ["laterdog://dog/bo\nat", "malformed"],
  ["laterdog://dog/bo\\at", "malformed"],
  ["laterdog://dog/b\u0001x", "malformed"],
  ["laterdog://dog/b\u007fx", "malformed"],
  ["laterdog://dog/boat#frag", "malformed"],
  ["laterdog://user:pass@dog/boat", "malformed"],
  ["laterdog://dog:9/boat", "malformed"],
  ["laterdog://dog/boat?x=1", "malformed"],
  ["laterdog://chat/boat?thread=a&thread=b", "malformed"],
  ["laterdog://dog/%E0%A4%A", "malformed"],
  ["laterdog://settings/usage?section=usage", "malformed"],
  ["laterdog://settings/a/b", "malformed"],
  ["https://later.dog/dog/boat", "scheme"],
  ["mailto:someone@example.com", "scheme"],
  ["laterdog://nope/boat", "route"],
  ["laterdog://install?url=https://github.com/x.md", "route"],
  ["laterdog://dog", "id"],
  ["laterdog://dog/a/b", "id"],
  ["laterdog://dog/..", "id"],
  ["laterdog://dog/a.b", "id"],
  [`laterdog://dog/${"a".repeat(129)}`, "id"],
  ["laterdog://thread/t-1", "id"],
  ["laterdog://thread/t-1?bot=", "id"],
];

test("each refused link gives one reason", () => {
  for (const [raw, reason] of refused) assert.deepEqual(parseAppLink(raw), { ok: false, reason }, String(raw).slice(0, 80));
});

test("log labels keep only the scheme and host", () => {
  assert.equal(appLinkLogLabel("https://x.test/cb?code=SECRET#t"), "https://x.test");
  assert.equal(appLinkLogLabel("laterdog-dev://chat/boat?thread=SECRET"), "laterdog-dev://chat");
  assert.equal(appLinkLogLabel("https://user:SECRET@x.test/"), "https://x.test");
  assert.equal(appLinkLogLabel("mailto:SECRET@example.com"), "mailto:");
  assert.equal(appLinkLogLabel("not a url SECRET"), "invalid");
  assert.equal(appLinkLogLabel(undefined), "invalid");
});
