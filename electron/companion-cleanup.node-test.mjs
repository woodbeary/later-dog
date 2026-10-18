import assert from "node:assert/strict";
import test from "node:test";
import { savedDesktopCompanion, withoutDesktopCompanion } from "./companion-cleanup.mjs";

const companion = { endpoint: "https://c-old.later.dog", token: `laterdog_${"a".repeat(43)}`, deviceId: "11111111-1111-4111-8111-111111111111", serverName: "Old computer" };

test("a saved companion pairing is found, even a malformed one", () => {
  assert.equal(savedDesktopCompanion({ desktopCompanionRemote: companion }), true);
  assert.equal(savedDesktopCompanion({ desktopCompanionRemote: "broken" }), true);
  assert.equal(savedDesktopCompanion({ provider: { fixture: true } }), false);
  assert.equal(savedDesktopCompanion(null), false);
  assert.equal(savedDesktopCompanion(undefined), false);
});

test("clearing the pairing keeps every other saved credential and leaves the input untouched", () => {
  const before = { provider: { fixture: true }, desktopOrganizationSettingsPending: true, desktopCompanionRemote: companion };
  const next = withoutDesktopCompanion(before);
  assert.deepEqual(next, { provider: { fixture: true }, desktopOrganizationSettingsPending: true });
  assert.equal(before.desktopCompanionRemote, companion);
  assert.equal(savedDesktopCompanion(next), false);
});
