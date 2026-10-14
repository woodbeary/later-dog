import { describe, expect, it } from "vitest";
import type { CloudLendingState } from "../../electron/computer-sharing.mjs";
import { lendingActionKey, lendingStatusKey } from "./CloudLending";

const snap = (state: Partial<CloudLendingState>) => ({ available: true, screenAvailable: true, state: { on: true, enabled: true, busy: false, ...state } });

describe("lendingStatusKey", () => {
  it("shows nothing before the first state arrives", () => {
    expect(lendingStatusKey(null)).toBeNull();
    expect(lendingStatusKey({ available: false, screenAvailable: false })).toBeNull();
  });

  it("puts off and busy ahead of everything else", () => {
    expect(lendingStatusKey(snap({ on: false, enabled: false, problem: "asleep" }))).toBe("lending.mac.off");
    expect(lendingStatusKey(snap({ busy: true, connected: false }))).toBe("lending.mac.busy");
  });

  it("names each connection state in plain words", () => {
    expect(lendingStatusKey(snap({ connected: true }))).toBe("lending.mac.ready");
    expect(lendingStatusKey(snap({ problem: "asleep" }))).toBe("lending.mac.resting");
    expect(lendingStatusKey(snap({ problem: "paused" }))).toBe("lending.status.paused");
    expect(lendingStatusKey(snap({ problem: "signed-out" }))).toBe("lending.status.paused");
    expect(lendingStatusKey(snap({ problem: "connect-first" }))).toBe("lending.mac.connecting");
    expect(lendingStatusKey(snap({ problem: "waiting" }))).toBe("lending.mac.connecting");
    expect(lendingStatusKey(snap({}))).toBe("lending.mac.connecting");
  });
});

describe("lendingActionKey", () => {
  it("falls back for unknown actions", () => {
    expect(lendingActionKey("read_file")).toBe("lending.action.readFile");
    expect(lendingActionKey("constructor")).toBe("lending.action.other");
  });
});
