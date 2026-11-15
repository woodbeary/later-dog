import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { GroupUsageReader } from "../group-thread-usage.ts";
import { summarizeUsage, type UsageRow } from "../usage-ledger.ts";
import { HISTORY_SUMMARY_PURPOSE } from "./summary-usage.ts";
import { countsAsTurn } from "./usage-turn.ts";

const turn = (at: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  at, botId: "b1", botName: "Scout", threadId: "room", instanceId: "claude", driverKind: "claudeAgent", model: "m",
  input: 100, output: 10, cachedInput: 50, costUsd: 0.01, trigger: { kind: "owner" }, ...extra,
});
const summary = (at: string) => turn(at, { purpose: HISTORY_SUMMARY_PURPOSE, input: 400, output: 40, costUsd: 0.04 });

it("does not count a history summary as a turn", () => {
  expect(countsAsTurn(turn("2026-09-01"))).toBe(true);
  expect(countsAsTurn(summary("2026-09-01"))).toBe(false);
});

it("keeps a summary's tokens and cost in the usage page totals but not in its turn count", () => {
  const { total, groups } = summarizeUsage([turn("2026-09-01T10:00:00Z"), summary("2026-09-01T10:01:00Z")], "bot");
  expect(total).toMatchObject({ turns: 1, input: 500, output: 50 });
  expect(total.costUsd).toBeCloseTo(0.05);
  expect(groups[0]).toMatchObject({ turns: 1, input: 500 });
});

it("keeps a summary's tokens in per-chat usage, without counting it as a turn or as the last turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-usage-turn-"));
  try {
    mkdirSync(join(dir, "usage"));
    writeFileSync(join(dir, "usage", "2026-09.jsonl"), [turn("2026-09-01T10:00:00Z"), summary("2026-09-01T10:01:00Z")].map(r => JSON.stringify(r)).join("\n") + "\n");
    const reader = new GroupUsageReader(dir);
    reader.refresh();
    const usage = reader.forThread("room")!;
    expect(usage).toMatchObject({ input: 500, output: 50, turns: 1, lastTurn: { input: 100, output: 10 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("leaves summaries out of a dog's turn times", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source).toContain("row.botId === botId && countsAsTurn(row)");
});
