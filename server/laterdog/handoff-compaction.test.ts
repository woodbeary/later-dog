import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { turnCompactWindow } from "../drivers/claude.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { AccountBattery, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { HANDOFF_COMPACTION_REPEAT_MS, HandoffCompactions, handoffCompactWindow, type HandoffCompactionFacts } from "./handoff-compaction.ts";

const NOW = Date.parse("2026-11-27T18:00:00Z");
const NEARLY_OUT: HandoffCompactionFacts = { driverKind: "claudeAgent", instanceId: "claude-b", left: 6, nextDriverKind: "codex", contextTokens: 240_000 };

const account = (instanceId: string, driverKind: string, model: string): BatteryAccount => ({
  instanceId, driverKind, displayName: instanceId, enabled: true, eligible: true, signedIn: true, models: [model], defaultModel: model,
});

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const battery = (accounts: BatteryAccount[], config: AccountBatteryConfig, backup?: { instanceId: string; model: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-handoff-compaction-"));
  dirs.push(dir);
  return new AccountBattery({ file: join(dir, "battery.json"), config: () => config, now: () => NOW, accounts: () => accounts, preferred: () => backup ? [backup] : undefined });
};

describe("compaction before a chat crosses to another provider", () => {
  it("asks Claude to compact below the chat's size when its account is nearly out and the next account is another provider", () => {
    expect(handoffCompactWindow(NEARLY_OUT)).toBe(216_000);
  });

  it("leaves compaction alone while the account has room, when the next account is Claude again, or when nothing is next", () => {
    expect(handoffCompactWindow({ ...NEARLY_OUT, left: 10 })).toBeUndefined();
    expect(handoffCompactWindow({ ...NEARLY_OUT, left: undefined })).toBeUndefined();
    expect(handoffCompactWindow({ ...NEARLY_OUT, nextDriverKind: "claudeAgent" })).toBeUndefined();
    expect(handoffCompactWindow({ ...NEARLY_OUT, nextDriverKind: undefined })).toBeUndefined();
  });

  it("asks nothing of engines whose compaction cannot be read, nor of chats small enough to hand over whole", () => {
    expect(handoffCompactWindow({ ...NEARLY_OUT, driverKind: "codex", nextDriverKind: "claudeAgent" })).toBeUndefined();
    expect(handoffCompactWindow({ ...NEARLY_OUT, contextTokens: 100_000 })).toBeUndefined();
    expect(handoffCompactWindow({ ...NEARLY_OUT, contextTokens: 105_000 })).toBe(100_000);
  });

  it("asks once per chat and account until the account could have recharged", () => {
    let now = NOW;
    const asked = new HandoffCompactions(() => now);
    expect(asked.window("chat", NEARLY_OUT)).toBe(216_000);
    expect(asked.window("chat", NEARLY_OUT)).toBeUndefined();
    expect(asked.window("other", NEARLY_OUT)).toBe(216_000);
    now += HANDOFF_COMPACTION_REPEAT_MS;
    expect(asked.window("chat", NEARLY_OUT)).toBe(216_000);
  });

  it("lowers Claude's standing compaction window for that turn only, never raising it", () => {
    expect(turnCompactWindow("280000", 216_000)).toBe("216000");
    expect(turnCompactWindow("280000", 400_000)).toBe("280000");
    expect(turnCompactWindow("auto", 216_000)).toBe("216000");
    expect(turnCompactWindow("280000", 40_000)).toBe("100000");
    expect(turnCompactWindow(null, 216_000)).toBeNull();
    expect(turnCompactWindow("280000", undefined)).toBe("280000");
  });

  it("names the account the battery would move a chat to once its account is out, another provider only through the dog's backup", () => {
    const claudeA = account("claude-a", "claudeAgent", "claude-opus-5-5");
    const claudeB = account("claude-b", "claudeAgent", "claude-opus-5-5");
    const codex = account("codex-a", "codex", "gpt-6.1-sol");
    const selection = { instanceId: "claude-a", model: "claude-opus-5-5" };
    const sameProvider = battery([claudeA, claudeB, codex], { enabled: true, order: { claudeAgent: ["claude-a", "claude-b"], codex: ["codex-a"] } });
    expect(sameProvider.nextWhenOut(selection, [claudeA, claudeB, codex], "chat")?.instanceId).toBe("claude-b");
    const lastClaude = battery([claudeA, codex], { enabled: true, order: { claudeAgent: ["claude-a"], codex: ["codex-a"] } }, { instanceId: "codex-a", model: "gpt-6.1-sol" });
    const next = lastClaude.nextWhenOut(selection, [claudeA, codex], "chat");
    expect(next?.instanceId).toBe("codex-a");
    const off = battery([claudeA, claudeB], { enabled: false, order: {} });
    expect(off.nextWhenOut(selection, [claudeA, claudeB], "chat")).toBeUndefined();
  });
});
