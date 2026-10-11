import { describe, expect, it, vi } from "vitest";
import { failedTurnCause } from "../../shared/failed-turn.ts";
import { AccountBattery, CONTINUE_AFTER_SWITCH, type AccountBatteryConfig, type BatteryAccount, type BatteryTurn } from "./account-battery.ts";
import { checkContinueOn, continueOnAccount, latestLimit, type PathMessage } from "./continue-on-account.ts";

const NOW = Date.parse("2026-10-07T18:30:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const account = (instanceId: string, displayName: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName, enabled: true, eligible: true, signedIn: true,
  models: ["claude-sonnet-5", "claude-opus-5"], ...extra,
});
const ACCOUNTS = [account("claude", "Personal"), account("claude-b", "Work"), account("claude-c", "Side")];
const SELECTION = { instanceId: "claude", model: "claude-sonnet-5" };
const OFF: AccountBatteryConfig = { enabled: false, order: {} };

const asked = (id: string): PathMessage => ({ id, role: "user", kind: "text" });
const ran = (id: string): PathMessage => ({ id, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, itemId: `item-${id}` } });
const failed = (id: string): PathMessage => ({ id, role: "bot", kind: "activity", tool: { name: "error: The run broke", ok: false } });
const limit = (id: string, instanceId = "claude"): PathMessage => ({
  id, role: "bot", kind: "activity", tool: { name: "error: You've hit your session limit", ok: false, quota: { instanceId } },
});

const setup = (options: {
  config?: AccountBatteryConfig;
  exhausted?: string[];
  path?: PathMessage[];
  busy?: boolean;
  rerun?: BatteryTurn["rerun"] | null;
  requestMessageId?: string;
  instanceId?: unknown;
} = {}) => {
  const battery = new AccountBattery({ config: () => options.config ?? OFF, now: () => NOW });
  for (const instanceId of options.exhausted ?? ["claude"]) battery.markExhausted(instanceId, { resetsAt: at(2 * HOUR), kind: "session" });
  const rerun = options.rerun === undefined ? vi.fn(async (_continuation: string | null) => undefined) : options.rerun;
  battery.trackTurn("thread-1", { generation: "g1", instanceId: "claude", requestMessageId: options.requestMessageId ?? "q1", ...(rerun ? { rerun } : {}) });
  const writes: Array<{ name: string; ok: boolean; replaceId?: string }> = [];
  const result = continueOnAccount({
    battery, accounts: ACCOUNTS, threadId: "thread-1", selection: SELECTION, busy: options.busy ?? false, generation: "g1",
    path: options.path ?? [asked("q0"), asked("q1"), limit("l1")], instanceId: options.instanceId ?? "claude-b",
    write: (tool, replaceId) => writes.push({ name: tool.name, ok: tool.ok, ...(replaceId ? { replaceId } : {}) }),
    now: NOW,
  });
  return { battery, rerun, writes, result };
};

describe("the limit a conversation hit", () => {
  it("is the latest failed row with a limit since the person last asked", () => {
    expect(latestLimit([asked("q0"), limit("old"), asked("q1"), ran("t"), limit("new"), failed("f")])?.id).toBe("new");
    expect(latestLimit([asked("q0"), limit("old"), asked("q1"), failed("f")])).toBeUndefined();
    expect(latestLimit([])).toBeUndefined();
  });
});

describe("checking a pick", () => {
  const check = (to: unknown, extra: { from?: string; accounts?: BatteryAccount[]; resting?: string[] } = {}) => checkContinueOn({
    accounts: extra.accounts ?? ACCOUNTS, selection: SELECTION, from: extra.from ?? "claude", to,
    resting: (candidate) => (extra.resting ?? []).includes(candidate.instanceId),
  });
  const refusal = (result: ReturnType<typeof check>) => (result.ok ? null : [result.status, result.error]);

  it("names why an account can't take the conversation", () => {
    expect(refusal(check(undefined))).toEqual([400, "Pick an account to continue on."]);
    expect(refusal(check(""))).toEqual([400, "Pick an account to continue on."]);
    expect(refusal(check("claude-b", { from: "claudeApi" }))).toEqual([409, "This dog's account can't switch."]);
    expect(refusal(check("claude-b", { accounts: [account("claude", "Personal", { eligible: false }), ...ACCOUNTS.slice(1)] })))
      .toEqual([409, "This dog's account can't switch."]);
    expect(refusal(check("gone"))).toEqual([404, "That account isn't available any more."]);
    expect(refusal(check("claude-b", { accounts: [ACCOUNTS[0]!, account("claude-b", "Work", { eligible: false })] })))
      .toEqual([404, "That account isn't available any more."]);
    expect(refusal(check("claude"))).toEqual([409, "That's the account that ran out."]);
    expect(refusal(check("chatgpt", { accounts: [...ACCOUNTS, account("chatgpt", "ChatGPT", { driverKind: "codex" })] })))
      .toEqual([409, "ChatGPT can't run this dog."]);
    expect(refusal(check("claude-b", { accounts: [ACCOUNTS[0]!, account("claude-b", "Work", { signedIn: false })] })))
      .toEqual([409, "Work isn't signed in."]);
    expect(refusal(check("claude-b", { accounts: [ACCOUNTS[0]!, account("claude-b", "Work", { enabled: false })] })))
      .toEqual([409, "Work isn't signed in."]);
    expect(refusal(check("claude-b", { accounts: [ACCOUNTS[0]!, account("claude-b", "Work", { models: ["claude-opus-5"] })] })))
      .toEqual([409, "Work doesn't offer this dog's model."]);
    expect(refusal(check("claude-b", { resting: ["claude-b"] }))).toEqual([409, "Work is out of usage too."]);
  });

  it("passes an account that can", () => {
    expect(check("claude-b")).toMatchObject({ ok: true, from: { instanceId: "claude" }, to: { instanceId: "claude-b" } });
    expect(check("claude-b", { accounts: [ACCOUNTS[0]!, account("claude-b", "Work", { signedIn: undefined })] }).ok).toBe(true);
  });
});

describe("continuing on another account", () => {
  it("runs the request again there and turns the limit row into the switch", () => {
    const { battery, rerun, writes, result } = setup();
    expect(result).toEqual({ status: 200, body: { continued: true } });
    expect(writes).toEqual([{
      name: expect.stringMatching(/^recovery: Switched to Work — Personal hit its 5-hour limit, resets (?:[A-Z][a-z]{2} \d{1,2} )?at \d{1,2}:\d{2} [AP]M\.$/),
      ok: true, replaceId: "l1",
    }]);
    expect(rerun).toHaveBeenCalledExactlyOnceWith(null);
    expect(battery.route(SELECTION, ACCOUNTS, "thread-1").instanceId).toBe("claude-b");
    expect(battery.takeTurn("thread-1", "g1")).toBeUndefined();
  });

  it("asks the dog to check what it already did when the turn had used tools", () => {
    const { rerun } = setup({ path: [asked("q1"), ran("t1"), limit("l1")] });
    expect(rerun).toHaveBeenCalledExactlyOnceWith(CONTINUE_AFTER_SWITCH);
  });

  it("says so in the chat when the run can't start there", async () => {
    const { writes } = setup({ rerun: vi.fn(async () => { throw new Error("spawn failed"); }) });
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ ok: false });
    expect(failedTurnCause(writes[1]!.name)).toBe("Could not continue on Work: spawn failed");
  });

  it("leaves the run to Retry when the turn can't run again, keeping the pick", () => {
    for (const options of [{ rerun: null }, { requestMessageId: "q0" }, { path: [asked("q1"), limit("l1"), asked("q2")] }]) {
      const { battery, writes, result } = setup(options);
      expect(result).toEqual({ status: 200, body: { continued: false } });
      expect(writes).toEqual([]);
      expect(battery.route(SELECTION, ACCOUNTS, "thread-1").instanceId).toBe("claude-b");
    }
  });

  it("takes the account that ran out from the limit row, not the dog's own", () => {
    const config = { enabled: true, order: { claudeAgent: ["claude-b", "claude", "claude-c"] } };
    const { battery, writes, result } = setup({ config, exhausted: ["claude-b"], path: [asked("q1"), limit("l1", "claude-b")], instanceId: "claude-c" });
    expect(result.status).toBe(200);
    expect(writes[0]?.name).toMatch(/^recovery: Switched to Side — Work hit its 5-hour limit/);
    expect(battery.route(SELECTION, ACCOUNTS, "thread-1").instanceId).toBe("claude-c");
    expect(setup({ config, exhausted: ["claude-b"], path: [asked("q1"), limit("l1", "claude-b")], instanceId: "claude-b" }).result)
      .toEqual({ status: 409, body: { error: "That's the account that ran out." } });
  });

  it("refuses while the dog is still working, or when the pick can't work, without moving anything", () => {
    const busy = setup({ busy: true });
    expect(busy.result).toEqual({ status: 409, body: { error: "This dog is still working." } });
    const tired = setup({ exhausted: ["claude", "claude-b"] });
    expect(tired.result).toEqual({ status: 409, body: { error: "Work is out of usage too." } });
    for (const { battery, rerun, writes } of [busy, tired]) {
      expect(battery.routes("thread-1")).toBe(false);
      expect(rerun).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    }
  });
});
