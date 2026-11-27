import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { buildReport, formatReport, readRows } from "./cache-hit-report.mjs";

const SCRIPT = join(import.meta.dirname, "cache-hit-report.mjs");
const row = (at: string, thread: string, account: string, input: number, cached?: number, written?: number) => ({
  at, botId: "b", botName: "Rex", threadId: thread, instanceId: account, driverKind: "claudeAgent", model: "m", input, output: 1,
  ...(cached === undefined ? {} : { cachedInput: cached }), ...(written === undefined ? {} : { cachedWrite: written }),
  costUsd: null, trigger: { kind: "owner" },
});

const ROWS = [
  row("2026-11-01T10:00:00Z", "chat-one-aaaa", "claude", 1000, 0, 1000),
  row("2026-11-01T10:05:00Z", "chat-one-aaaa", "claude", 1100, 1000, 100),
  row("2026-11-01T10:10:00Z", "chat-one-aaaa", "claude-b", 1200, 0, 1200),
  row("2026-11-01T10:15:00Z", "chat-one-aaaa", "claude-b", 1300, 1200, 100),
  row("2026-11-02T09:00:00Z", "chat-two-bbbb", "claude", 500, 250, 0),
  row("2026-11-02T09:01:00Z", "chat-two-bbbb", "claude", 700),
];

const dirs: string[] = [];
const ledger = (rows: unknown[], month = "2026-11") => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-cache-report-"));
  dirs.push(dir);
  mkdirSync(join(dir, "usage"));
  writeFileSync(join(dir, "usage", `${month}.jsonl`), rows.map((entry) => JSON.stringify(entry)).join("\n") + "\nnot json\n\n");
  return dir;
};
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

describe("cache hit report", () => {
  it("reports hit rates per account", () => {
    const report = buildReport(readRows(ledger(ROWS)));
    const claude = report.byAccount.find((entry: { account: string }) => entry.account === "claude");
    expect(claude).toMatchObject({ turns: 3, input: 2600, cached: 1250, written: 1100, unmeasured: 1 });
    expect(claude.hitRate).toBeCloseTo(1250 / 2600);
    const second = report.byAccount.find((entry: { account: string }) => entry.account === "claude-b");
    expect(second.hitRate).toBeCloseTo(1200 / 2500);
  });

  it("reports hit rates per chat and leaves out turns without cache numbers", () => {
    const report = buildReport(readRows(ledger(ROWS)));
    const two = report.byChat.find((entry: { chat: string }) => entry.chat === "chat-two-bbbb");
    expect(two).toMatchObject({ turns: 1, input: 500, cached: 250, unmeasured: 1, dog: "Rex" });
    expect(two.hitRate).toBe(0.5);
  });

  it("shows the hit rate before and after a chat changed account", () => {
    const report = buildReport(readRows(ledger(ROWS)));
    expect(report.moved).toHaveLength(1);
    const [before, after] = report.moved[0].segments;
    expect(before).toMatchObject({ account: "claude", turns: 2 });
    expect(after).toMatchObject({ account: "claude-b", turns: 2 });
    expect(after.hitRate).toBeCloseTo(1200 / 2500);
  });

  it("honours a time range", () => {
    const rows = readRows(ledger(ROWS), { since: "2026-11-02T00:00:00Z" });
    expect(rows).toHaveLength(2);
  });

  it("says n/a when nothing was measured", () => {
    const report = buildReport(readRows(ledger([row("2026-11-01T10:00:00Z", "t", "a", 10)])));
    expect(report.total.hitRate).toBeNull();
    expect(formatReport(report)).toContain("n/a");
  });

  it("runs from the command line against a data directory", () => {
    const dir = ledger(ROWS);
    const text = execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(text).toContain("Per account");
    expect(text).toContain("claude-b");
    expect(text).toContain("Chats that changed account");
    const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, dir, "--json", "--chat", "chat-two"], { encoding: "utf8" }));
    expect(json.byChat).toHaveLength(1);
    expect(json.total.hitRate).toBe(0.5);
  });

  it("fails clearly on a missing ledger", () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, join(tmpdir(), "no-such-ledger-dir")], { encoding: "utf8", stdio: "pipe" })).toThrow();
  });
});
