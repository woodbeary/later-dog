import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { AccountBattery, CONTINUE_AFTER_RESET, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { waitsOnPerson } from "./account-needs-you.ts";
import { carryOnAfterReset } from "./carry-on.ts";
import { carryOnAfterRestart } from "./carry-on-restart.ts";
import type { PathMessage } from "./continue-on-account.ts";
import { LimitHold, RECHECK_MS } from "./limit-hold.ts";
import { settlePickup, shownWaiting, usageHeld, type PickupHold } from "./person-wait.ts";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const HOUR = 3600_000;

let dir: string;
let file: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), "laterdog-person-wait-"));
  file = join(dir, "limit-hold.json");
});
afterEach(async () => {
  vi.useRealTimers();
  await removeTempDir(dir);
});

const saved = () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).waiting : {};

describe("a wait on the person in the hold", () => {
  it("has no carry-on time, is saved, and tells apps once when it starts and once when it ends", () => {
    const onChange = vi.fn();
    const hold = new LimitHold({ readyAt: () => undefined, wake: vi.fn(), onChange, file });
    expect(hold.awaitPerson("t")).toBe(true);
    expect(hold.awaitPerson("t")).toBe(false);
    vi.advanceTimersByTime(10 * RECHECK_MS);
    expect(onChange).toHaveBeenCalledOnce();
    expect(hold.waiting()).toEqual({});
    expect(hold.nextAt()).toBeUndefined();
    expect(hold.waitsOnPerson("t")).toBe(true);
    expect(saved()).toEqual({ t: { since: new Date(NOW).toISOString(), person: true } });
    hold.release("t");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(saved()).toEqual({});
  });

  it("is found again after a restart without waking the chat or showing a carry-on time", () => {
    new LimitHold({ readyAt: () => undefined, wake: vi.fn(), file }).awaitPerson("t");
    const wake = vi.fn();
    const onChange = vi.fn();
    const restarted = new LimitHold({ readyAt: () => undefined, wake, onChange, file });
    expect(restarted.resume()).toEqual(["t"]);
    expect(wake).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledOnce();
    expect(restarted.waitsOnPerson("t")).toBe(true);
    expect(restarted.restored("t")).toBe(true);
    expect(restarted.waiting()).toEqual({});
    restarted.recheckPerson("t");
    expect(wake).toHaveBeenCalledExactlyOnceWith("t");
    expect(Object.keys(saved())).toEqual(["t"]);
  });

  it("turns into a timed wait or a retry, saved as such, when the pickup says so", () => {
    const hold = new LimitHold({ readyAt: () => new Date(NOW + HOUR).toISOString(), wake: vi.fn(), file });
    hold.awaitPerson("t");
    hold.hold("t");
    expect(hold.waitsOnPerson("t")).toBe(false);
    expect(hold.waiting()).toEqual({ t: new Date(NOW + HOUR).toISOString() });
    expect(saved().t.person).toBeUndefined();
  });
});

describe("what a pickup's answer does to the hold", () => {
  const fake = (person = false) => {
    const calls: string[] = [];
    const hold: PickupHold = {
      awaitPerson: () => { calls.push("awaitPerson"); return true; },
      retry: () => { calls.push("retry"); },
      hold: () => { calls.push("hold"); },
      release: () => { calls.push("release"); },
      waitsOnPerson: () => person,
    };
    return { hold, calls };
  };

  it.each([
    ["needs-you", "reset", false, ["awaitPerson"]],
    ["needs-you", "restart", false, ["awaitPerson"]],
    ["full", "reset", false, ["retry"]],
    ["waiting", "restart", false, ["hold"]],
    ["started", "reset", true, ["release"]],
    ["started", "restart", false, ["release"]],
    ["skipped", "restart", false, ["release"]],
    ["skipped", "reset", false, []],
    ["skipped", "reset", true, ["release"]],
    [undefined, "reset", true, ["release"]],
  ] as const)("%s after a %s, waiting on the person %s", (outcome, after, person, expected) => {
    const { hold, calls } = fake(person);
    settlePickup(hold, "t", outcome, after);
    expect(calls).toEqual(expected);
  });

  it("keeps chats waiting on the person out of the shown carry-on times and out of usage refreshes", () => {
    const waiting = { limit: "a", person: "b", gone: "c" };
    const onPerson = (threadId: string) => threadId === "person";
    expect(shownWaiting(waiting, { carriesOn: (threadId) => threadId !== "gone", waitsOnPerson: onPerson })).toEqual({ limit: "a" });
    expect(usageHeld(waiting, onPerson)).toEqual(["limit", "gone"]);
  });
});

describe("a chat waiting on a signed-out account across a restart", () => {
  const account = (instanceId: string, signedIn: boolean): BatteryAccount => ({
    instanceId, driverKind: "claudeAgent", displayName: `Claude ${instanceId}`, enabled: true, eligible: true, signedIn, models: ["claude-opus-5"],
  });
  const CONFIG: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["one", "two"] } };
  const DOG = { instanceId: "one", model: "claude-opus-5" };
  const PATH: PathMessage[] = [
    { id: "ask", role: "user", kind: "text" },
    { id: "limit", role: "bot", kind: "activity", tool: { name: "error: You've hit your limit", ok: false, quota: { instanceId: "one" } } },
  ];

  it("keeps the wait, shows no carry-on time after the restart, and carries on once the account is signed in again", () => {
    const accounts = [account("one", false), account("two", false)];
    const before = new AccountBattery({ config: () => CONFIG, now: () => NOW });
    const rerun = vi.fn(async () => undefined);
    before.trackTurn("dog", { generation: "g1", instanceId: "one", requestMessageId: "ask", rerun });
    const running = new LimitHold({ readyAt: () => undefined, wake: vi.fn(), file });
    running.hold("dog");
    const outcome = carryOnAfterReset({ battery: before, accounts, threadId: "dog", selection: DOG, generation: "g1", path: PATH, full: false, write: vi.fn() });
    expect(outcome).toBe("needs-you");
    settlePickup(running, "dog", outcome, "reset");
    expect(rerun).not.toHaveBeenCalled();
    expect(Object.keys(saved())).toEqual(["dog"]);

    const battery = new AccountBattery({ config: () => CONFIG, now: () => NOW });
    const start = vi.fn(async () => undefined);
    const write = vi.fn();
    const restart = () => carryOnAfterRestart({ battery, accounts, threadId: "dog", selection: DOG, path: PATH, full: false, write, start });
    const hold: LimitHold = new LimitHold({
      readyAt: () => undefined,
      wake: (threadId) => settlePickup(hold, threadId, hold.restored(threadId) && !battery.keptTurn(threadId, undefined) ? restart() : undefined, "restart"),
      file,
    });
    const recheck = () => { if (!waitsOnPerson(battery.decide(DOG, accounts, "dog"))) hold.recheckPerson("dog"); };
    hold.resume();
    expect(hold.waitsOnPerson("dog")).toBe(true);
    expect(hold.waiting()).toEqual({});
    for (let tick = 0; tick < 5; tick += 1) recheck();
    expect(start).not.toHaveBeenCalled();
    expect(Object.keys(saved())).toEqual(["dog"]);

    accounts[0] = account("one", true);
    recheck();
    expect(start).toHaveBeenCalledExactlyOnceWith(CONTINUE_AFTER_RESET, "ask");
    expect(hold.waitsOnPerson("dog")).toBe(false);
    expect(saved()).toEqual({});
  });
});
