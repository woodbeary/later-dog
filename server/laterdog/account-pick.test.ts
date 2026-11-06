import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AccountBattery, type BatteryAccount } from "./account-battery.ts";
import { pickMovesTurn } from "./account-pick.ts";

const daniel = { instanceId: "claude-daniel", model: "claude-opus-5-5" };
const adam = { instanceId: "claude", model: "claude-opus-5-5" };

describe("picking an account for a chat whose turn runs elsewhere", () => {
  it("moves the running turn when the person taps the account the chat is already set to", () => {
    expect(pickMovesTurn({ before: daniel, after: daniel, runningOn: "claude", routedTo: "claude-daniel" })).toBe(true);
  });

  it("moves the running turn when the person picks a different account", () => {
    expect(pickMovesTurn({ before: adam, after: daniel, runningOn: "claude", routedTo: "claude-daniel" })).toBe(true);
  });

  it("leaves the turn alone when only the model or effort changes", () => {
    expect(pickMovesTurn({ before: daniel, after: { ...daniel, effort: "high" }, runningOn: "claude", routedTo: "claude-daniel" })).toBe(false);
  });

  it("leaves the turn alone when it already runs there, nothing runs, or the picked account can't take it", () => {
    expect(pickMovesTurn({ before: daniel, after: daniel, runningOn: "claude-daniel", routedTo: "claude-daniel" })).toBe(false);
    expect(pickMovesTurn({ before: daniel, after: daniel, runningOn: undefined, routedTo: "claude-daniel" })).toBe(false);
    expect(pickMovesTurn({ before: daniel, after: daniel, runningOn: "claude", routedTo: "claude-anthony" })).toBe(false);
  });

  it("is wired into both app pick paths, and clears the chat's old placement", () => {
    const server = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(server.match(/followAccountPick\(/g)?.length).toBe(3);
    expect(server).toMatch(/function followAccountPick[^]*?accountBattery\.pin\(threadId, after\.instanceId\)/);
    expect(server).toContain("const carryingOn = automaticallyCarriesOn(event) || movingOn;");
    expect(server).toContain("if (movingOn) continueOnPickedAccount(");
  });
});


describe("a chat the person picked an account for", () => {
  const claude = (instanceId: string): BatteryAccount => ({
    instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true, models: ["claude-opus-5-5"],
  });
  const ACCOUNTS = [claude("claude"), claude("claude-daniel"), claude("claude-anthony")];
  const config = { enabled: true, order: { claudeAgent: ["claude-daniel", "claude", "claude-anthony"] } };
  const fresh = () => new AccountBattery({ config: () => config, accounts: () => ACCOUNTS, now: () => Date.parse("2026-11-06T21:00:00Z"),
    running: () => ({ "claude-daniel": 5 }), defaultAccount: () => "claude-daniel" });

  it("runs on that account again after the home had moved it away, even when other accounts are less busy", () => {
    const battery = fresh();
    battery.noteSwitch("patch", "claude-daniel", "claude");
    battery.pin("patch", "claude-daniel");
    expect(battery.route(daniel, ACCOUNTS, "patch").instanceId).toBe("claude-daniel");
  });

  it("still moves off it when it runs out", () => {
    const battery = fresh();
    battery.pin("patch", "claude-daniel");
    battery.markExhausted("claude-daniel", { resetsAt: "2026-11-06T23:00:00Z" });
    expect(battery.route(daniel, ACCOUNTS, "patch").instanceId).not.toBe("claude-daniel");
  });
});
