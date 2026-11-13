import { describe, expect, it } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import type { BatteryAccount, Rest } from "./account-battery.ts";
import { choiceReadyAt, decideAccount, roomOf, shownRoute, type AccountChoiceInput } from "./account-choice.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const claude = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-fable-5-2", "claude-opus-5-5"], defaultModel: "claude-opus-5-5", ...extra,
});
const chatgpt = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "codex", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["gpt-6.1-sol"], defaultModel: "gpt-6.1-sol", ...extra,
});
const ACCOUNTS = [claude("jacob"), claude("adam"), claude("anthony"), claude("daniel"), chatgpt("chatgpt")];
const ON_DANIEL = { instanceId: "daniel", model: "claude-fable-5-2", effort: "high" as const };
const ON_CHATGPT = { instanceId: "chatgpt", model: "gpt-6.1-sol", effort: "medium" as const };

const window = (usedPercent: number, resetsAt = at(4 * HOUR)) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt });
const reading = (id: string, fiveHour: number, weekly = 10, credits?: PlanProviderRow["credits"]): PlanProviderRow => ({
  id, name: id, driver: "claude", plan: "Max", ok: true, error: null, fiveHour: window(fiveHour), weekly: window(weekly, at(96 * HOUR)),
  extra: [], models: [], ...(credits ? { credits } : {}),
});
const hold = (offset: number, extra: Partial<Rest> = {}): Rest => ({ until: at(offset), since: at(0), ...extra });

const decide = (overrides: Partial<AccountChoiceInput> = {}) => decideAccount({
  chosen: ON_DANIEL, accounts: ACCOUNTS, keepGoing: true, resting: {}, now: NOW, ...overrides,
});
const readings = (left: Record<string, number>) => (id: string) => left[id] === undefined ? undefined : reading(id, 100 - left[id]!);

describe("the person's choice is a pin", () => {
  it("runs on the chosen account while it can run, whatever the others have left", () => {
    const usage = readings({ daniel: 3, adam: 90, anthony: 80, jacob: 70 });
    const choice = decide({ usage });
    expect(choice).toEqual({ kind: "chosen", run: ON_DANIEL });
    expect(choice.run).toBe(ON_DANIEL);
  });

  it("is left alone for an account the battery does not manage", () => {
    const api = { instanceId: "api", model: "claude-opus-5-5" };
    expect(decide({ chosen: api, accounts: [...ACCOUNTS, claude("api", { eligible: false })], resting: { api: hold(HOUR) } })).toEqual({ kind: "chosen", run: api });
  });

  it("keeps the chosen account when it has no reading yet or its sign-in is not checked yet", () => {
    expect(decide({ accounts: [claude("daniel", { signedIn: undefined }), claude("adam")] }).run.instanceId).toBe("daniel");
  });
});

describe("when the chosen account cannot run", () => {
  const usage = readings({ adam: 1, anthony: 60, jacob: 40 });

  it.each([
    ["limit", { resting: { daniel: hold(2 * HOUR) } }],
    ["signedOut", { accounts: ACCOUNTS.map((account) => account.instanceId === "daniel" ? { ...account, signedIn: false } : account) }],
    ["off", { accounts: ACCOUNTS.map((account) => account.instanceId === "daniel" ? { ...account, enabled: false } : account) }],
    ["signIn", { resting: { daniel: hold(HOUR, { kind: "setup" }) } }],
  ] as const)("moves to the same-engine account with the most left (%s)", (blocked, extra) => {
    const choice = decide({ usage, ...extra });
    expect(choice.kind).toBe("covering");
    expect(choice.run).toEqual({ ...ON_DANIEL, instanceId: "anthony" });
    expect(choice).toMatchObject({ chosen: "daniel", blocked });
  });

  it("says until when the chosen account is out", () => {
    expect(decide({ usage, resting: { daniel: hold(2 * HOUR) } })).toMatchObject({ until: at(2 * HOUR) });
  });

  it("waits on the chosen account with Keep going off", () => {
    expect(decide({ usage, keepGoing: false, resting: { daniel: hold(2 * HOUR) } })).toEqual({
      kind: "waiting", run: ON_DANIEL, chosen: "daniel", blocked: "limit", until: at(2 * HOUR),
    });
  });

  it("never picks an account under 5% while another has more, and an unknown reading only after known room", () => {
    const resting = { daniel: hold(HOUR) };
    expect(decide({ resting, usage: readings({ adam: 1, anthony: 30 }) }).run.instanceId).toBe("anthony");
    expect(decide({ resting, usage: readings({ adam: 1, anthony: 30, jacob: 60 }) }).run.instanceId).toBe("jacob");
    expect(decide({ resting, usage: readings({ adam: 4, anthony: 2 }) }).run.instanceId).toBe("jacob");
    expect(decide({ resting, usage: readings({ adam: 4, anthony: 2, jacob: 3 }), accounts: ACCOUNTS }).run.instanceId).toBe("adam");
  });

  it("uses the binding window, session or week", () => {
    const resting = { daniel: hold(HOUR) };
    const usage = (id: string) => ({ adam: reading("adam", 10, 97), anthony: reading("anthony", 50, 20), jacob: reading("jacob", 80, 5) } as Record<string, PlanProviderRow>)[id];
    expect(decide({ resting, usage }).run.instanceId).toBe("anthony");
  });

  it("counts paid credits as usage that is available, after accounts with plan room", () => {
    const resting = { daniel: hold(HOUR) };
    const credited = reading("adam", 100, 100, { unlimited: false, balance: "42" });
    expect(roomOf(credited, NOW)).toEqual({ left: 0, credits: true });
    expect(roomOf(reading("adam", 100, 100, { unlimited: false, balance: "0" }), NOW).credits).toBe(false);
    expect(decide({ resting, usage: (id) => id === "adam" ? credited : reading(id, 99) }).run.instanceId).toBe("adam");
    expect(decide({ resting, usage: (id) => id === "adam" ? credited : id === "jacob" ? reading(id, 50) : reading(id, 99) }).run.instanceId).toBe("jacob");
  });

  describe("which account covers, and when the one covering is left", () => {
    const resting = { daniel: hold(HOUR) };
    const creditsOnly = (id: string) => reading(id, 100, 100, { unlimited: false, balance: "40" });
    const rows = (byId: Record<string, PlanProviderRow>) => (id: string) => byId[id];
    const accounts = [claude("daniel"), claude("adam"), claude("anthony"), claude("jacob")];
    const cover = (byId: Record<string, PlanProviderRow>, current?: string) => decide({ accounts, resting, usage: rows(byId), ...(current ? { current } : {}) }).run.instanceId;

    it("chooses known plan room, then no reading, then paid credits only, then nearly empty", () => {
      expect(cover({ adam: creditsOnly("adam"), anthony: reading("anthony", 99), jacob: reading("jacob", 50) })).toBe("jacob");
      expect(cover({ adam: creditsOnly("adam"), anthony: reading("anthony", 99) })).toBe("jacob");
      expect(cover({ adam: creditsOnly("adam"), anthony: reading("anthony", 99), jacob: reading("jacob", 98) })).toBe("adam");
    });

    it("leaves a cover on paid credits only for an account with known plan room", () => {
      expect(cover({ adam: creditsOnly("adam"), anthony: reading("anthony", 5, 10), jacob: reading("jacob", 99) }, "adam")).toBe("anthony");
      expect(cover({ adam: creditsOnly("adam"), anthony: reading("anthony", 99) }, "adam")).toBe("adam");
    });

    it("after a restart, keeps a cover with no reading while readings arrive as paid credits only, or even with room", () => {
      expect(cover({}, "anthony")).toBe("anthony");
      expect(cover({ adam: creditsOnly("adam") }, "anthony")).toBe("anthony");
      expect(cover({ adam: reading("adam", 10) }, "anthony")).toBe("anthony");
    });

    it("leaves a nearly empty cover only for a better group", () => {
      expect(cover({ adam: reading("adam", 98), anthony: reading("anthony", 96), jacob: reading("jacob", 97) }, "adam")).toBe("adam");
      expect(cover({ adam: reading("adam", 98), anthony: creditsOnly("anthony"), jacob: reading("jacob", 97) }, "adam")).toBe("anthony");
    });
  });

  it("never picks a disabled, signed-out, not-yet-checked, held or model-less account", () => {
    const accounts = [
      claude("daniel"), claude("adam", { enabled: false }), claude("anthony", { signedIn: false }), claude("jacob", { signedIn: undefined }),
      claude("beth", { models: ["claude-opus-5-5"] }), claude("cara"), chatgpt("chatgpt"),
    ];
    const usage = readings({ adam: 90, anthony: 90, jacob: 90, beth: 90, cara: 20 });
    expect(decide({ accounts, usage, resting: { daniel: hold(HOUR) } }).run.instanceId).toBe("cara");
    expect(decide({ accounts, usage, resting: { daniel: hold(HOUR), cara: hold(HOUR) } }).kind).toBe("waiting");
  });

  it("stays on the account already covering while it is as good a tier, so the chat does not hop", () => {
    const resting = { daniel: hold(HOUR) };
    expect(decide({ resting, current: "jacob", usage: readings({ jacob: 40, anthony: 60 }) }).run.instanceId).toBe("jacob");
    expect(decide({ resting, current: "adam", usage: readings({ adam: 2, anthony: 60 }) }).run.instanceId).toBe("anthony");
  });

  it("goes back to the chosen account as soon as it can run again", () => {
    expect(decide({ current: "anthony", resting: { daniel: hold(-1) } })).toEqual({ kind: "chosen", run: ON_DANIEL });
  });

  it("runs on an account the person picked by hand for this chat while the chosen one is out, on any engine", () => {
    const choice = decide({ resting: { daniel: hold(HOUR) }, handPicked: "chatgpt" });
    expect(choice).toMatchObject({ kind: "covering", byHand: true, run: { instanceId: "chatgpt", model: "gpt-6.1-sol" } });
  });
});

describe("never crossing engines by itself", () => {
  it("waits for usage when no Claude account can run, even with ChatGPT free", () => {
    const resting = Object.fromEntries(["jacob", "adam", "anthony", "daniel"].map((id) => [id, hold(id === "adam" ? HOUR : 3 * HOUR)]));
    const choice = decide({ resting, usage: readings({ chatgpt: 100 }) });
    expect(choice).toMatchObject({ kind: "waiting", run: ON_DANIEL, blocked: "limit" });
    expect(choiceReadyAt({ chosen: ON_DANIEL, accounts: ACCOUNTS, keepGoing: true, resting, now: NOW })).toBe(at(HOUR));
  });

  it("keeps a ChatGPT dog on ChatGPT and waits when that is the only ChatGPT account", () => {
    const choice = decide({ chosen: ON_CHATGPT, resting: { chatgpt: hold(2 * HOUR) }, usage: readings({ adam: 100 }) });
    expect(choice).toMatchObject({ kind: "waiting", run: ON_CHATGPT });
  });

  it("knows when a waiting chat can run: the soonest reset among the accounts it may use, and never while one can run", () => {
    const resting = { daniel: hold(3 * HOUR), adam: hold(HOUR), anthony: hold(2 * HOUR), jacob: hold(4 * HOUR) };
    const input = { chosen: ON_DANIEL, accounts: ACCOUNTS, keepGoing: true, resting, now: NOW };
    expect(choiceReadyAt(input)).toBe(at(HOUR));
    expect(choiceReadyAt({ ...input, keepGoing: false })).toBe(at(3 * HOUR));
    expect(choiceReadyAt({ ...input, resting: { daniel: hold(HOUR) } })).toBeUndefined();
  });
});

describe("what the picker shows", () => {
  it("shows nothing extra when the turn ran on the chosen account", () => {
    expect(shownRoute(decide(), ON_DANIEL, { on: "daniel", model: "claude-fable-5-2" })).toBeUndefined();
    expect(shownRoute(decide(), ON_DANIEL, undefined)).toBeUndefined();
  });

  it("shows where it is running, with the model that ran, while the chosen account is out", () => {
    const choice = decide({ resting: { daniel: hold(HOUR) }, usage: readings({ anthony: 60 }) });
    expect(shownRoute(choice, ON_DANIEL, { on: "anthony", model: "claude-fable-5-2" })).toEqual({ from: "daniel", on: "anthony", model: "claude-fable-5-2" });
  });

  it("says From the next message when the person picks while the dog works, or when the chosen account is back", () => {
    expect(shownRoute(decide(), ON_DANIEL, { on: "adam", model: "claude-fable-5-2" })).toEqual({ from: "daniel", on: "adam", model: "claude-fable-5-2", next: true });
  });
});

describe("the dated incidents", () => {
  it("11-03: a ChatGPT account is never shown running a Claude model, because a Claude dog never lands on ChatGPT", () => {
    const resting = Object.fromEntries(["jacob", "adam", "anthony", "daniel"].map((id) => [id, hold(HOUR)]));
    expect(decide({ resting }).run).toEqual(ON_DANIEL);
  });

  it("11-04 and 11-06: selecting daniel runs on daniel, and the line says From the next message while the old turn finishes", () => {
    const picked = decide({ usage: readings({ daniel: 50, adam: 90 }) });
    expect(picked.run.instanceId).toBe("daniel");
    expect(shownRoute(picked, ON_DANIEL, { on: "adam", model: "claude-fable-5-2" })?.next).toBe(true);
  });

  it("11-06: with jacob out, a dog moves to anthony with the most left, not to adam at 1%", () => {
    const choice = decide({ chosen: { ...ON_DANIEL, instanceId: "jacob" }, resting: { jacob: hold(HOUR) }, usage: readings({ adam: 1, anthony: 70, daniel: 30 }) });
    expect(choice.run.instanceId).toBe("anthony");
  });

  it("11-07 and 11-10: a reading that shows room again, or paid credits, keeps the dog on its account", () => {
    const credited = (id: string) => id === "chatgpt" ? { ...reading(id, 100, 100, { unlimited: true, balance: null }), driver: "codex" } : undefined;
    expect(decide({ chosen: ON_CHATGPT, usage: credited }).run).toEqual(ON_CHATGPT);
  });

  it("11-09 and 11-10: a Fable dog on Claude never ends up on ChatGPT, it waits instead", () => {
    const resting = Object.fromEntries(["jacob", "adam", "anthony", "daniel"].map((id) => [id, hold(HOUR)]));
    expect(decide({ resting }).kind).toBe("waiting");
    expect(decide({ chosen: ON_CHATGPT, resting: { chatgpt: hold(HOUR) } }).kind).toBe("waiting");
  });
});
