import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, loadavg, platform, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executionAdvice as after, type AdviceCandidate } from "../server/laterdog/execution-advisor.ts";
import type { UsageRow } from "../server/usage-ledger.ts";

const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const baselineRef = process.argv.includes("--baseline-ref") ? argument("--baseline-ref") : "d2c39c4ede7308ee905b620e0473d2a65374a217";
if (!/^[a-f0-9]{7,40}$/.test(baselineRef ?? "")) throw new Error("Supply a baseline commit hash.");
const output = resolve(process.argv.includes("--output") ? argument("--output") : ".laterdog-evidence/execution-advice-benchmark.json");
const temporary = await mkdtemp(join(tmpdir(), "laterdog-advice-bench-"));
try {
  const source = execFileSync("git", ["show", `${baselineRef}:server/laterdog/execution-advisor.ts`], { encoding: "utf8" });
  const baselinePath = join(temporary, "before.ts");
  await writeFile(baselinePath, source.replace('"../model-prices.ts"', JSON.stringify(resolve("server/model-prices.ts"))));
  const before = (await import(pathToFileURL(baselinePath).href)).executionAdvice as typeof after;
  const now = Date.parse("2026-11-08T12:00:00Z");
  const candidates: AdviceCandidate[] = Array.from({ length: 100 }, (_, i) => ({ instanceId: `account-${Math.floor(i / 10)}`, model: `model-${i}`, enabled: i % 3 !== 0, authenticated: i % 5 !== 0, available: true }));
  const current = { instanceId: candidates[10].instanceId, model: candidates[10].model, effort: "medium" as const };
  const host = { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, totalmem: totalmem(), freemem: freemem(), load: loadavg(), otherWork: "User workloads remain active; the host is not certified idle." };
  const results = [];
  let equivalentRepliesChecked = 0;
  for (const count of [50, 2000, 100_000]) {
    const rows: UsageRow[] = Array.from({ length: count }, (_, i) => {
      const c = candidates[i % candidates.length];
      return { at: new Date(now - i % 100 * 1000).toISOString(), botId: "fixture", botName: "Fixture", threadId: `thread-${i % 20}`, instanceId: c.instanceId, driverKind: "fixture", model: c.model, input: 100, output: i % 7, costUsd: i % 5 ? null : .01, costSource: "estimated", trigger: { kind: "owner" }, ...(i % 4 ? { execution: { selected: current, dispatched: { instanceId: c.instanceId, model: c.model }, providerInstanceId: c.instanceId, attribution: i % 17 ? "dispatch" as const : "conflict" as const, startedAt: new Date(now - 10000).toISOString(), completedAt: new Date(now).toISOString(), durationMs: i % 300, providerSucceeded: i % 11 !== 0, verification: "unverified" as const, task: i % 2 ? "inspect account controls" : "repair queue recovery", turnId: `turn-${i}` } } : {}) };
    });
    const input = { task: "inspect account controls", current, candidates, rows, now };
    assert.deepEqual(after(input), before(input));
    equivalentRepliesChecked++;
    const samples = { before: [] as number[], after: [] as number[] };
    const calls = count === 100_000 ? 5 : 30;
    for (let pass = 0; pass < 7; pass++) for (const name of (pass % 2 ? ["after", "before"] : ["before", "after"]) as Array<keyof typeof samples>) {
      global.gc?.();
      const fn = name === "before" ? before : after;
      const start = performance.now();
      let bytes = 0;
      for (let i = 0; i < calls; i++) bytes += Buffer.byteLength(JSON.stringify(fn(input)));
      const ms = (performance.now() - start) / calls;
      assert(bytes > 0);
      if (pass >= 2) samples[name].push(ms);
    }
    const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[2], minMs: sorted[0], maxMs: sorted.at(-1), rawMs: values }; };
    const advice = { historyVisibility: "own_dog", ...after(input) };
    const beforeWire = JSON.stringify({ ...advice, text: JSON.stringify(advice) });
    const afterWire = JSON.stringify(advice);
    assert.deepEqual(JSON.parse(JSON.parse(beforeWire).text), JSON.parse(afterWire));
    results.push({ rows: count, candidates: candidates.length, callsPerSample: calls, before: stats(samples.before), after: stats(samples.after), wireBytes: { before: Buffer.byteLength(beforeWire), after: Buffer.byteLength(afterWire) } });
  }
  for (let seed = 0; seed < 100; seed++) {
    const c = candidates[seed % candidates.length];
    const rows: UsageRow[] = Array.from({ length: seed * 3 }, (_, i) => ({ at: new Date(now - i % 5 * 1000).toISOString(), botId: "fixture", botName: "Fixture", threadId: `t-${i % 3}`, instanceId: i % 3 ? c.instanceId : "missing", driverKind: "fixture", model: c.model, input: 0, output: 1, costUsd: i % 2 ? null : 0, trigger: { kind: "owner" } }));
    const input = { task: seed % 2 ? "account controls" : "", current, candidates: candidates.slice(0, seed), rows, now };
    assert.deepEqual(after(input), before(input));
    equivalentRepliesChecked++;
  }
  const result = { at: new Date().toISOString(), baselineRef, scope: "Local synthetic advisor calculation plus JSON serialization; excludes ledger reads, HTTP, models, queueing and task quality. No production capacity or savings claim.", host, equivalentRepliesChecked, results };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  assert(JSON.parse(await readFile(output, "utf8")).equivalentRepliesChecked === 103);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
