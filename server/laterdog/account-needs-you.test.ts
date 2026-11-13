import { describe, expect, it, vi } from "vitest";
import type { AccountChoice } from "./account-choice.ts";
import { accountNeedsYou, personWaitLog, waitsOnPerson } from "./account-needs-you.ts";

const run = { instanceId: "daniel", model: "claude-fable-5-2" };
const waiting = (blocked: "limit" | "signIn" | "signedOut" | "off"): AccountChoice => ({ kind: "waiting", run, chosen: "daniel", blocked });
const names: Record<string, string> = { daniel: "Daniel" };
const line = (choice: AccountChoice, keptWaiting = true, name = (id: string): string | undefined => names[id]) => accountNeedsYou({ keptWaiting, choice, name });

describe("a chat whose chosen account needs the person", () => {
  it("asks to sign in again when the account is signed out or failed to sign in", () => {
    expect(line(waiting("signedOut"))).toBe("Sign in to Daniel again");
    expect(line(waiting("signIn"))).toBe("Sign in to Daniel again");
  });

  it("asks to turn the account back on when it is off", () => {
    expect(line(waiting("off"))).toBe("Turn Daniel back on");
  });

  it("names the account by its id when it has no name", () => {
    expect(line(waiting("off"), true, () => "  ")).toBe("Turn daniel back on");
    expect(line(waiting("signedOut"), true, () => undefined)).toBe("Sign in to daniel again");
  });

  it("says nothing for a limit, for a chat with nothing kept, or when the turn can run", () => {
    expect(line(waiting("limit"))).toBeUndefined();
    expect(line(waiting("signedOut"), false)).toBeUndefined();
    expect(line({ kind: "chosen", run })).toBeUndefined();
    expect(line({ kind: "covering", run: { ...run, instanceId: "adam" }, chosen: "daniel", blocked: "signedOut" })).toBeUndefined();
  });

  it("waits on the person only for a waiting decision that is not a limit", () => {
    expect(["limit", "signIn", "signedOut", "off"].map((blocked) => waitsOnPerson(waiting(blocked as "limit")))).toEqual([false, true, true, true]);
    expect(waitsOnPerson({ kind: "chosen", run })).toBe(false);
  });
});

describe("logging a wait on the person", () => {
  it("logs when the wait is first seen and when it ends, not on every check", () => {
    const log = vi.fn();
    const waits = personWaitLog(log);
    waits.waiting("t", "waits");
    waits.waiting("t", "waits");
    expect(waits.has("t")).toBe(true);
    expect(waits.over("t", "over")).toBe(true);
    expect(waits.over("t", "over")).toBe(false);
    expect(log.mock.calls).toEqual([["waits"], ["over"]]);
  });

  it("forgets chats that no longer wait without logging", () => {
    const log = vi.fn();
    const waits = personWaitLog(log);
    waits.waiting("a", "a waits");
    waits.waiting("b", "b waits");
    waits.keepOnly(["b"]);
    expect([waits.has("a"), waits.has("b")]).toEqual([false, true]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
