import { describe, expect, it } from "vitest";
import {
  beatWidth,
  cloudSignInDue,
  completionPatch,
  EMPTY_ONBOARDING,
  hintSeen,
  hostedMember,
  spotlightsQuiet,
  hintSeenPatch,
  LOCAL_VIEWER,
  nextBeat,
  previousBeat,
  welcomeDue,
  welcomeViewer,
  WELCOME_BEATS,
  WELCOME_VERSION,
} from "./onboarding";

const done = { completedAt: "2026-09-09T10:00:00.000Z", version: WELCOME_VERSION, reelSeen: false, hintsSeen: [] };

describe("welcomeDue", () => {
  it("waits for the server before deciding", () => {
    expect(welcomeDue(null, { legacyDone: false })).toBe(false);
    expect(welcomeDue(undefined, { legacyDone: false })).toBe(false);
  });

  it("shows the tour to a fresh workspace", () => {
    expect(welcomeDue({}, { legacyDone: false })).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { legacyDone: false })).toBe(true);
  });

  it("respects a completion at the current version", () => {
    expect(welcomeDue({ onboarding: done }, { legacyDone: false })).toBe(false);
  });

  it("re-shows a flow completed at an older version", () => {
    expect(welcomeDue({ onboarding: { ...done, version: WELCOME_VERSION - 1 } }, { legacyDone: false })).toBe(true);
  });

  it("honours the old localStorage gate for one release", () => {
    expect(welcomeDue({}, { legacyDone: true })).toBe(false);
    expect(welcomeDue({ onboarding: { ...done, version: 0 } }, { legacyDone: true })).toBe(true);
  });

  it("decides who gets the tour on a fresh workspace", () => {
    const fresh = { onboarding: EMPTY_ONBOARDING };
    const cases = [
      { who: "local desktop", options: { legacyDone: false, ...LOCAL_VIEWER }, due: true },
      { who: "hosted admin", options: { legacyDone: false, hosted: true, canSave: true }, due: true },
      { who: "hosted member", options: { legacyDone: false, hosted: true, canSave: false }, due: false },
      { who: "member of a self-hosted server", options: { legacyDone: false, hosted: false, canSave: false }, due: false },
      { who: "hosted, scope unknown", options: { legacyDone: false, hosted: true }, due: false },
    ];
    for (const { who, options, due } of cases) expect(welcomeDue(fresh, options), who).toBe(due);
  });
});

describe("welcomeViewer", () => {
  it("reads the session defensively", () => {
    expect(welcomeViewer({ kind: "loopback", scopes: ["admin", "client"] })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], hosted: true })).toEqual({ hosted: true, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["client"], hosted: true })).toEqual({ hosted: true, canSave: false });
    expect(welcomeViewer({ kind: "session", scopes: ["client"] })).toEqual({ hosted: false, canSave: false });
    expect(welcomeViewer({ kind: "loopback", scopes: ["client"], trust: "service" })).toEqual({ hosted: false, canSave: false });
    expect(welcomeViewer({})).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer(null)).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer({ scopes: ["admin"], hosted: "yes" })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: true })).toEqual({ hosted: false, canSave: true, cloudHome: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: "yes" })).toEqual({ hosted: false, canSave: true });
  });

  it("calls only a hosted session without admin scope a hosted member", () => {
    expect(hostedMember({ hosted: true, canSave: false })).toBe(true);
    expect(hostedMember({ hosted: true, canSave: true })).toBe(false);
    expect(hostedMember({ hosted: false, canSave: false })).toBe(false);
    expect(hostedMember(LOCAL_VIEWER)).toBe(false);
    expect(hostedMember(null)).toBe(false);
    expect(spotlightsQuiet(null)).toBe(true);
    expect(spotlightsQuiet({ hosted: true, canSave: false })).toBe(true);
    expect(spotlightsQuiet({ hosted: false, canSave: false })).toBe(false);
    expect(spotlightsQuiet(LOCAL_VIEWER)).toBe(false);
  });
});

describe("first run on a later.dog Cloud home", () => {
  const connected = welcomeViewer({ kind: "session", scopes: ["admin", "client"], via: "cookie", cloudHome: true });
  const engine = (id: string, authenticated: boolean | undefined, state = "available") => ({ id, state, authenticated });
  const ready = (instance: ReturnType<typeof engine>) => instance.state === "available" && instance.authenticated !== false;
  const signedOut = [engine("claude", false), engine("codex", false), engine("opencodeGo", undefined, "unavailable")];

  it("routes the connected app to the engine sign-in, not the welcome flow", () => {
    expect(cloudSignInDue(connected, { connected: true, instances: signedOut }, ready)).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { legacyDone: false, ...connected })).toBe(false);
  });

  it("hands over to the chat once any engine can run", () => {
    for (const signedIn of [engine("claude", true), engine("codex", true), engine("anthropic-key", undefined)]) {
      expect(cloudSignInDue(connected, { connected: true, instances: [...signedOut, signedIn] }, ready)).toBe(false);
    }
  });

  it("waits for the server, and changes nothing anywhere else", () => {
    expect(cloudSignInDue(connected, { connected: false, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue(connected, { connected: true, instances: [] }, ready)).toBe(false);
    expect(cloudSignInDue(null, { connected: true, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue({ ...connected, canSave: false }, { connected: true, instances: signedOut }, ready)).toBe(false);
    for (const viewer of [LOCAL_VIEWER, { hosted: true, canSave: true }, welcomeViewer({ kind: "session", scopes: ["admin", "client"] })]) {
      expect(cloudSignInDue(viewer, { connected: true, instances: signedOut }, ready)).toBe(false);
      expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { legacyDone: false, ...viewer })).toBe(true);
    }
  });
});

describe("persistence patches", () => {
  it("stamps completion with the current version", () => {
    expect(completionPatch(new Date("2026-09-09T12:34:56.000Z"))).toEqual({
      onboarding: { completedAt: "2026-09-09T12:34:56.000Z", version: WELCOME_VERSION },
    });
  });

  it("adds a hint once and never writes a no-op", () => {
    expect(hintSeen(undefined, "computer")).toBe(false);
    expect(hintSeenPatch(undefined, "computer")).toEqual({ onboarding: { hintsSeen: ["computer"] } });
    const record = { ...EMPTY_ONBOARDING, hintsSeen: ["computer"] };
    expect(hintSeen(record, "computer")).toBe(true);
    expect(hintSeenPatch(record, "computer")).toBeNull();
    expect(hintSeenPatch(record, "apps")).toEqual({ onboarding: { hintsSeen: ["computer", "apps"] } });
  });
});

describe("beat machine", () => {
  it("greets, then meets the dog, and asks nothing about this computer or engines", () => {
    expect(WELCOME_BEATS).toEqual(["hello", "bot"]);
  });

  it("walks forward and back and stops at the ends", () => {
    expect(nextBeat(WELCOME_BEATS, "hello")).toBe("bot");
    expect(nextBeat(WELCOME_BEATS, "bot")).toBeNull();
    expect(previousBeat(WELCOME_BEATS, "bot")).toBe("hello");
    expect(previousBeat(WELCOME_BEATS, "hello")).toBeNull();
  });

  it("gives the bot beat more room than the greeting", () => {
    expect(beatWidth("bot")).toBeGreaterThan(beatWidth("hello"));
  });
});
