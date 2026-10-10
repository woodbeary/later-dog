import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const profiles = require("./profiles.cjs");

const ids = (...values) => {
  const queue = [...values];
  return () => queue.shift();
};

test("a missing or damaged file is just the one Personal profile", () => {
  for (const raw of ["", "{", "null", "[]", "42", JSON.stringify({ profiles: "nope" })]) {
    assert.deepEqual(profiles.parseProfiles(raw), { mainName: "", activeId: "main", profiles: [] });
  }
});

test("parsing keeps only well-formed profiles with their own ports", () => {
  const state = profiles.parseProfiles(JSON.stringify({
    mainName: "  Home   stuff ",
    activeId: "p00000000000b",
    profiles: [
      { id: "p00000000000a", name: "Business", port: 8811 },
      { id: "p00000000000b", name: " Business  2 ", port: 8813 },
      { id: "p00000000000a", name: "Duplicate id", port: 8815 },
      { id: "p00000000000c", name: "Same port", port: 8813 },
      { id: "p00000000000d", name: "Odd port", port: 8812 },
      { id: "p00000000000e", name: "Main's port", port: 8799 },
      { id: "main", name: "Not main", port: 8817 },
      { id: "../escape", name: "Bad id", port: 8819 },
      { id: "p00000000000f", name: "   ", port: 8821 },
    ],
  }));
  assert.deepEqual(state, {
    mainName: "Home stuff",
    activeId: "p00000000000b",
    profiles: [
      { id: "p00000000000a", name: "Business", port: 8811 },
      { id: "p00000000000b", name: "Business 2", port: 8813 },
    ],
  });
});

test("an active id that no longer exists falls back to Personal", () => {
  const state = profiles.parseProfiles({ activeId: "p0000000000ff", profiles: [{ id: "p00000000000a", name: "Business", port: 8811 }] });
  assert.equal(state.activeId, "main");
});

test("serialize and parse round-trip", () => {
  const start = { mainName: "Personal", activeId: "p00000000000a", profiles: [{ id: "p00000000000a", name: "Business", port: 8811 }] };
  assert.deepEqual(profiles.parseProfiles(profiles.serializeProfiles(start)), start);
});

test("adding gives each profile the next free pair of ports", () => {
  let state = profiles.emptyProfiles();
  const first = profiles.withProfile(state, "Business", ids("p00000000000a"));
  state = first.state;
  assert.deepEqual(first.profile, { id: "p00000000000a", name: "Business", port: 8811 });
  const second = profiles.withProfile(state, "Business 2", ids("p00000000000b"));
  assert.equal(second.profile.port, 8813);
  state = profiles.withoutProfile(second.state, "p00000000000a");
  const third = profiles.withProfile(state, "Side project", ids("p00000000000c"));
  assert.equal(third.profile.port, 8811);
  assert.equal(profiles.nextPort(third.state, [8815, 8817]), 8819);
});

test("adding needs a name, a fresh id, and room", () => {
  const empty = profiles.emptyProfiles();
  assert.throws(() => profiles.withProfile(empty, "   ", ids("p00000000000a")), /needs a name/);
  const retried = profiles.withProfile(empty, "Business", ids("bad", "../x", "p00000000000a"));
  assert.equal(retried.profile.id, "p00000000000a");
  assert.throws(() => profiles.withProfile(empty, "Business", () => "bad"), /Could not name/);
  let state = empty;
  for (let index = 0; index < profiles.MAX_PROFILES - 1; index++) {
    state = profiles.withProfile(state, `Profile ${index}`, ids(`p${String(index).padStart(12, "0")}`)).state;
  }
  assert.equal(profiles.canAddProfile(state), false);
  assert.throws(() => profiles.withProfile(state, "One too many", ids("p0000000000ff")), /up to 8 profiles/);
});

test("names are trimmed and capped; Personal can go back to its default", () => {
  const { state } = profiles.withProfile(profiles.emptyProfiles(), "Business", ids("p00000000000a"));
  const renamed = profiles.withName(state, "p00000000000a", `  ${"x".repeat(60)} `);
  assert.equal(renamed.profiles[0].name.length, profiles.MAX_NAME);
  assert.equal(profiles.withName(state, "p00000000000a", "   "), state);
  assert.equal(profiles.withName(state, "p0000000000ff", "Ghost"), state);
  assert.equal(profiles.withName(state, "main", "Home").mainName, "Home");
  assert.equal(profiles.withName({ ...state, mainName: "Home" }, "main", "").mainName, "");
});

test("Personal can never be removed, and removing the active profile returns to it", () => {
  const { state } = profiles.withProfile(profiles.emptyProfiles(), "Business", ids("p00000000000a"));
  assert.equal(profiles.withoutProfile(state, "main"), state);
  const active = profiles.withActive(state, "p00000000000a");
  assert.equal(profiles.activeProfile(active)?.name, "Business");
  const removed = profiles.withoutProfile(active, "p00000000000a");
  assert.equal(removed.activeId, "main");
  assert.equal(profiles.activeProfile(removed), null);
  assert.equal(profiles.withActive(state, "p0000000000ff"), state);
});

test("a profile moves only to a free valid port", () => {
  let state = profiles.withProfile(profiles.emptyProfiles(), "Business", ids("p00000000000a")).state;
  state = profiles.withProfile(state, "Business 2", ids("p00000000000b")).state;
  assert.equal(profiles.withPort(state, "p00000000000a", 8813), state);
  assert.equal(profiles.withPort(state, "p00000000000a", 8800), state);
  assert.equal(profiles.withPort(state, "p00000000000a", 8815).profiles[0].port, 8815);
});

test("a new profile starts with only the person's name, email and tour progress", () => {
  const seed = profiles.profileSeed(JSON.stringify({
    profile: { name: "  Anthony Reed ", email: "a@example.com", aboutMe: "Private notes" },
    onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: 2, reelSeen: true, hintsSeen: ["composer", " composer ", "", 7, "x".repeat(61)], firstTurnAt: "2026-10-01T09:05:00.000Z" },
    xai: { key: "xai-secret" },
    rooms: { enabled: true },
  }));
  assert.deepEqual(seed, {
    profile: { name: "Anthony Reed", email: "a@example.com" },
    onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: 2, reelSeen: true, hintsSeen: ["composer"] },
  });
});

test("a profile seed drops anything malformed and is nothing when nothing is left", () => {
  for (const raw of ["", "{", "null", "[]", "42", JSON.stringify({ xai: { key: "secret" } }), JSON.stringify({ profile: { name: "   " }, onboarding: { version: 2.5, reelSeen: "yes", hintsSeen: "composer" } })]) {
    assert.equal(profiles.profileSeed(raw), null);
  }
  assert.deepEqual(
    profiles.profileSeed(JSON.stringify({ profile: { name: "n".repeat(321), email: 5 }, onboarding: { completedAt: "c".repeat(41), version: 3 } })),
    { onboarding: { version: 3 } },
  );
  assert.equal(
    profiles.profileSeed(JSON.stringify({ onboarding: { hintsSeen: Array.from({ length: 150 }, (_, index) => `hint-${index}`) } })).onboarding.hintsSeen.length,
    100,
  );
});

test("the list the window sees has no ports and marks Personal", () => {
  const { state } = profiles.withProfile(profiles.emptyProfiles(), "Business", ids("p00000000000a"));
  assert.deepEqual(profiles.profileList(profiles.withActive(state, "p00000000000a"), () => "starting"), {
    activeId: "p00000000000a",
    canAdd: true,
    profiles: [
      { id: "main", name: "", main: true, status: "running" },
      { id: "p00000000000a", name: "Business", main: false, status: "starting" },
    ],
  });
  assert.equal(profiles.profileOrigin({ port: 8811 }), "http://127.0.0.1:8811");
});
