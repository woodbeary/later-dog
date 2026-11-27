import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { BatteryAccount } from "./account-battery.ts";
import { gatherText, spreadParts, startSwarmInput, SWARM_DEADLINE_MS, SwarmBook, type StartSwarmInput, type SwarmStarter } from "./swarm.ts";

const NOW = Date.parse("2026-11-27T19:00:00Z");
const MODEL = "claude-opus-5-5";
const account = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true, models: [MODEL], defaultModel: MODEL, ...extra,
});
const row = (usedPercent: number): PlanProviderRow => ({
  ok: true, fiveHour: { available: true, usedPercent, resetsAt: "2026-11-27T22:00:00Z" }, weekly: { available: true, usedPercent: 10, resetsAt: "2026-12-02T00:00:00Z" },
} as unknown as PlanProviderRow);
const PARENT = { instanceId: "a", model: MODEL };
const INPUT: StartSwarmInput = {
  goal: "Check five sites",
  parts: ["one", "two", "three", "four", "five"].map((title) => ({ title, instruction: `check ${title}` })),
  gather: "One table.",
};

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const file = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-swarm-")); dirs.push(dir); return join(dir, "swarms.json"); };

const fakeStarter = (opened: { title: string; instanceId: string }[], failTitle?: string): SwarmStarter & { settle: Map<string, () => void> } => {
  const settle = new Map<string, () => void>();
  return {
    settle,
    open: (title, selection) => {
      if (title === failTitle) return null;
      opened.push({ title, instanceId: selection.instanceId });
      return `task-${title}`;
    },
    run: async (threadId, _instruction, settled) => { settle.set(threadId, settled); },
  };
};

describe("swarm parts across accounts", () => {
  it("keeps every part on the chat's account while it has more than half left, so one cache stays warm", () => {
    const accounts = [account("a"), account("b")];
    const usage = (id: string) => (id === "a" ? row(30) : row(0));
    expect(spreadParts({ parent: PARENT, count: 5, accounts, usage, resting: {}, now: NOW }).map((s) => s.instanceId)).toEqual(["a", "a", "a", "a", "a"]);
  });

  it("spreads parts by room left, unmeasured accounts last, never on resting, signed-out, other-engine or used-up accounts", () => {
    const accounts = [
      account("a"), account("b"), account("c"), account("unmeasured"), account("resting"), account("out", { signedIn: false }),
      account("empty"), account("codex", { driverKind: "codex", models: ["gpt"], defaultModel: "gpt" }),
    ];
    const used: Record<string, number> = { a: 70, b: 20, c: 50, resting: 0, out: 0, empty: 100, codex: 0 };
    const usage = (id: string) => (id in used ? row(used[id]!) : undefined);
    const resting = { resting: { until: "2026-11-27T23:00:00Z", since: "2026-11-27T18:00:00Z" } };
    expect(spreadParts({ parent: PARENT, count: 5, accounts, usage, resting, now: NOW }).map((s) => s.instanceId))
      .toEqual(["b", "c", "a", "unmeasured", "b"]);
  });

  it("checks what a dog may ask for", () => {
    expect(startSwarmInput.safeParse(INPUT).success).toBe(true);
    expect(startSwarmInput.safeParse({ ...INPUT, parts: INPUT.parts.slice(0, 1) }).success).toBe(false);
    expect(startSwarmInput.safeParse({ ...INPUT, parts: [...INPUT.parts, ...INPUT.parts] }).success).toBe(false);
    expect(startSwarmInput.safeParse({ ...INPUT, gather: "" }).success).toBe(false);
  });
});

describe("swarm book", () => {
  it("starts each part as a task on its account, gathers once when all parts end, and survives a restart", async () => {
    let now = NOW;
    const path = file();
    const book = new SwarmBook(path, () => now);
    const opened: { title: string; instanceId: string }[] = [];
    const starter = fakeStarter(opened);
    const selections = ["a", "b", "a", "b", "c"].map((instanceId) => ({ instanceId, model: MODEL }));
    const settled: string[] = [];
    const { record, failed } = await book.start(starter, "dog", "parent", INPUT, selections, (threadId) => settled.push(threadId));
    expect(failed).toEqual([]);
    expect(opened.map((part) => part.instanceId)).toEqual(["a", "b", "a", "b", "c"]);
    starter.settle.get("task-one")!();
    expect(settled).toEqual(["task-one"]);
    for (const title of ["one", "two", "three", "four"]) book.ended(`task-${title}`, "done", `${title} is fine`);
    expect(book.due()).toEqual([]);
    const reopened = new SwarmBook(path, () => now);
    expect(reopened.open().map((entry) => entry.id)).toEqual([record.id]);
    reopened.ended("task-five", "failed", undefined);
    expect(reopened.due().map((entry) => entry.id)).toEqual([record.id]);
    const text = gatherText(reopened.due()[0]!, now);
    expect(text).toContain("finished all 5 parts");
    expect(text).toContain("one is fine");
    expect(text).toContain("One table.");
    reopened.gathered(record.id);
    expect(reopened.due()).toEqual([]);
    expect(reopened.ended("task-five", "done", "late")).toBeUndefined();
    now += 1;
  });

  it("gathers what came back at the deadline and names the parts still working", async () => {
    let now = NOW;
    const book = new SwarmBook(file(), () => now);
    const { record } = await book.start(fakeStarter([]), "dog", "parent", INPUT, INPUT.parts.map(() => PARENT), () => {});
    book.ended("task-one", "done", "one is fine");
    expect(book.due()).toEqual([]);
    now += SWARM_DEADLINE_MS;
    expect(book.due().map((entry) => entry.id)).toEqual([record.id]);
    expect(gatherText(book.due()[0]!, now)).toContain("4 of 5 parts still working");
  });

  it("reports parts that could not open and records only the ones that did", async () => {
    const book = new SwarmBook(file(), () => NOW);
    const { record, failed } = await book.start(fakeStarter([], "two"), "dog", "parent", INPUT, INPUT.parts.map(() => PARENT), () => {});
    expect(record.parts.map((part) => part.title)).toEqual(["one", "three", "four", "five"]);
    expect(failed).toEqual([{ title: "two", error: "it couldn't be opened" }]);
  });
});
