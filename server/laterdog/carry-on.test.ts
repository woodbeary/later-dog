import { describe, expect, it, vi } from "vitest";
import { failedTurnCause } from "../../shared/failed-turn.ts";
import { AccountBattery, CONTINUE_AFTER_RESET, type AccountBatteryConfig, type BatteryAccount, type BatteryTurn } from "./account-battery.ts";
import { carriesOn, carryOnAfterReset } from "./carry-on.ts";
import type { PathMessage } from "./continue-on-account.ts";

const NOW = Date.parse("2026-10-07T18:30:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const account = (instanceId: string, displayName: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName, enabled: true, eligible: true, signedIn: true,
  models: ["claude-sonnet-5", "claude-opus-5"], ...extra,
});
const ACCOUNTS = [account("claude", "Personal"), account("claude-b", "Work")];
const SELECTION = { instanceId: "claude", model: "claude-sonnet-5" };
const ON: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["claude", "claude-b"] } };

const asked = (id: string): PathMessage => ({ id, role: "user", kind: "text" });
const switched = (id: string): PathMessage => ({
  id, role: "bot", kind: "activity", tool: { name: "recovery: Switched to Work — Personal hit its 5-hour limit.", ok: true },
});
const ran = (id: string): PathMessage => ({ id, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, itemId: `item-${id}` } });
const limit = (id: string, instanceId: string): PathMessage => ({
  id, role: "bot", kind: "activity", tool: { name: "error: You've hit your session limit", ok: false, quota: { instanceId } },
});

const setup = (options: {
  config?: AccountBatteryConfig;
  accounts?: BatteryAccount[];
  resets?: Record<string, number>;
  path?: PathMessage[];
  rerun?: BatteryTurn["rerun"] | null;
  requestMessageId?: string;
  generation?: string;
} = {}) => {
  let now = NOW;
  const battery = new AccountBattery({ config: () => options.config ?? ON, now: () => now });
  for (const [instanceId, offset] of Object.entries(options.resets ?? { claude: HOUR, "claude-b": 2 * HOUR })) {
    battery.markExhausted(instanceId, { resetsAt: at(offset), kind: "session" });
  }
  battery.noteSwitch("thread-1", "claude");
  const rerun = options.rerun === undefined ? vi.fn(async (_continuation: string | null) => undefined) : options.rerun;
  battery.trackTurn("thread-1", { generation: "g1", instanceId: "claude-b", requestMessageId: options.requestMessageId ?? "q1", ...(rerun ? { rerun } : {}) });
  const input = {
    battery, accounts: options.accounts ?? ACCOUNTS, threadId: "thread-1", selection: SELECTION, generation: options.generation ?? "g1",
    path: options.path ?? [asked("q0"), asked("q1"), switched("s1"), limit("l1", "claude-b")],
  };
  const writes: Array<{ name: string; ok: boolean; replaceId?: string }> = [];
  const carryOn = (full = false) => carryOnAfterReset({
    ...input, full, write: (tool, replaceId) => writes.push({ name: tool.name, ok: tool.ok, ...(replaceId ? { replaceId } : {}) }),
  });
  return { battery, rerun, input, writes, carryOn, pass: (ms: number) => { now += ms; } };
};

describe("carrying on once a limit resets", () => {
  it("waits while every account rests, then runs the request again on the first one back", () => {
    const { battery, rerun, input, writes, carryOn, pass } = setup();
    expect(carriesOn(input)).toBe(true);
    expect(carryOn()).toBe("skipped");
    expect(rerun).not.toHaveBeenCalled();
    pass(HOUR);
    expect(carryOn()).toBe("started");
    expect(writes).toEqual([{ name: "recovery: Picking up where it stopped, on Personal.", ok: true, replaceId: "l1" }]);
    expect(rerun).toHaveBeenCalledExactlyOnceWith(null);
    expect(battery.takeBack("thread-1", "claude")).toBe(false);
    expect(carriesOn(input)).toBe(false);
    expect(carryOn()).toBe("skipped");
    expect(writes).toHaveLength(1);
  });

  it("carries on with whichever account frees up first, still owing the move back", () => {
    const { battery, writes, carryOn, pass } = setup({ resets: { claude: 2 * HOUR, "claude-b": HOUR } });
    pass(HOUR);
    expect(carryOn()).toBe("started");
    expect(writes[0]?.name).toBe("recovery: Picking up where it stopped, on Work.");
    expect(battery.takeBack("thread-1", "claude")).toBe(true);
  });

  it("asks the dog to check what it already did when the stopped turn had used tools", () => {
    const { rerun, carryOn, pass } = setup({ path: [asked("q1"), ran("t1"), limit("l1", "claude")] });
    pass(HOUR);
    expect(carryOn()).toBe("started");
    expect(rerun).toHaveBeenCalledExactlyOnceWith(CONTINUE_AFTER_RESET);
  });

  it("waits for a free slot when the dog is busy elsewhere, keeping the turn", () => {
    const { battery, rerun, writes, carryOn, pass } = setup();
    pass(HOUR);
    expect(carryOn(true)).toBe("full");
    expect(rerun).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(battery.keptTurn("thread-1", "g1")).toBeDefined();
    expect(carryOn()).toBe("started");
  });

  it("says so in the chat when the run can't start", async () => {
    const { writes, carryOn, pass } = setup({ rerun: vi.fn(async () => { throw new Error("spawn failed"); }) });
    pass(HOUR);
    carryOn();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ ok: false });
    expect(failedTurnCause(writes[1]!.name)).toBe("Could not carry on with Personal: spawn failed");
  });

  it("leaves the conversation alone when carry-on is off, the turn can't run again, or newer words came in", () => {
    const cases = [
      { config: { ...ON, enabled: false } },
      { rerun: null },
      { requestMessageId: "q0" },
      { generation: "g2" },
      { path: [asked("q1"), limit("l1", "claude-b"), asked("q2")] },
      { accounts: [account("claude", "Personal", { eligible: false }), account("claude-b", "Work")] },
    ];
    for (const options of cases) {
      const { rerun, input, writes, carryOn, pass } = setup(options);
      pass(2 * HOUR);
      expect(carriesOn(input)).toBe(false);
      expect(carryOn()).toBe("skipped");
      expect(writes).toEqual([]);
      if (rerun) expect(rerun).not.toHaveBeenCalled();
    }
  });
});
