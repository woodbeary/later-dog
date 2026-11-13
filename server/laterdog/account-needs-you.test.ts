import { describe, expect, it } from "vitest";
import type { AccountChoice } from "./account-choice.ts";
import { accountNeedsYou, switchedOff, waitsOnPerson } from "./account-needs-you.ts";

const run = { instanceId: "daniel", model: "claude-fable-5-2" };
const waiting = (blocked: "limit" | "signIn" | "signedOut" | "off"): AccountChoice => ({ kind: "waiting", run, chosen: "daniel", blocked });
const names: Record<string, string> = { daniel: "Daniel" };
const needs = (choice: AccountChoice, carriesOn = true, name = (id: string): string | undefined => names[id]) => accountNeedsYou({ carriesOn, choice, name });
const line = (...args: Parameters<typeof needs>) => needs(...args)?.what;

describe("a chat whose chosen account needs the person", () => {
  it("asks to sign in again when the account is signed out or failed to sign in", () => {
    expect(line(waiting("signedOut"))).toBe("Sign in to Daniel again");
    expect(line(waiting("signIn"))).toBe("Sign in to Daniel again");
  });

  it("asks to turn the account back on when it is off", () => {
    expect(line(waiting("off"))).toBe("Turn Daniel back on");
  });

  it("says which account holds the chat and why in a field beside the words", () => {
    expect(needs(waiting("off"))?.hold).toEqual({ account: "Daniel", accountId: "daniel", why: "off" });
    expect(needs(waiting("signedOut"))?.hold).toEqual({ account: "Daniel", accountId: "daniel", why: "signed-out" });
    expect(needs(waiting("signIn"))?.hold).toEqual({ account: "Daniel", accountId: "daniel", why: "signed-out" });
    expect(needs(waiting("off"), true, () => undefined)?.hold).toEqual({ account: "daniel", accountId: "daniel", why: "off" });
    expect(needs(waiting("limit"))).toBeUndefined();
  });

  it("names the account by its id when it has no name", () => {
    expect(line(waiting("off"), true, () => "  ")).toBe("Turn daniel back on");
    expect(line(waiting("signedOut"), true, () => undefined)).toBe("Sign in to daniel again");
  });

  it("says nothing for a limit, for a chat that will not carry on by itself, or when the turn can run", () => {
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

describe("a new message to a switched-off account", () => {
  it("waits only when the chosen account is off and nothing covers", () => {
    expect(["limit", "signIn", "signedOut", "off"].map((blocked) => switchedOff(waiting(blocked as "limit")))).toEqual([false, false, false, true]);
    expect(switchedOff({ kind: "covering", run: { ...run, instanceId: "adam" }, chosen: "daniel", blocked: "off" })).toBe(false);
  });
});
