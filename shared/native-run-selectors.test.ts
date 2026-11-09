import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNativeContractManifest, NATIVE_CONTRACT_MANIFEST } from "../scripts/testing/native-contract-manifest.ts";
import { actorAncestry, applyNativeRun, nativeActorRole, nativeExecutionComparison, nativePuppies, nativeReceiptAnchors } from "./native-run-selectors.ts";
import type { NativeRun } from "./native-runs.ts";

const run = (overrides: Partial<NativeRun> = {}): NativeRun => ({
  id: "run", threadId: "thread", turnId: "turn", provider: "claudeAgent", providerInstanceId: "claude-a", revision: 1, startedAt: 10, state: "running", observation: "live",
  actors: [
    { id: "parent", kind: "parent", label: "Main", state: "running", startedAt: 10, model: "opus" },
    { id: "a", parentId: "parent", kind: "subagent", label: "A", state: "running", startedAt: 11 },
    { id: "b", parentId: "a", kind: "subagent", label: "B", state: "done", startedAt: 12 },
    { id: "t", parentId: "parent", kind: "task", label: "Shell", state: "running", startedAt: 12 },
    { id: "w", parentId: "parent", kind: "workflow", label: "Flow", state: "running", startedAt: 12 },
  ],
  activityCount: 0, failureCount: 0, limitations: [], ...overrides,
});

describe("native run selectors", () => {
  it("separates puppies from the main agent, tasks and workflows", () => {
    expect(nativePuppies(run()).map(actor => actor.id)).toEqual(["a", "b"]);
    expect(run().actors.map(nativeActorRole)).toEqual(["main", "puppy", "puppy", "task", "workflow"]);
  });

  it("walks ancestry from the root without looping on a corrupt cycle", () => {
    const base = run();
    expect(actorAncestry(base, base.actors[2]!).map(actor => actor.id)).toEqual(["parent", "a"]);
    const cyclic = run({ actors: [{ id: "x", parentId: "y", kind: "subagent", label: "X", state: "running", startedAt: 1 }, { id: "y", parentId: "x", kind: "subagent", label: "Y", state: "running", startedAt: 1 }] });
    expect(actorAncestry(cyclic, cyclic.actors[0]!).map(actor => actor.id)).toEqual(["y"]);
  });

  it("applies revisions in order and ignores replayed, stale and malformed snapshots", () => {
    const first = applyNativeRun([], run());
    expect(applyNativeRun(first, run())).toBe(first);
    expect(applyNativeRun(first, run({ revision: 0 }))).toBe(first);
    expect(applyNativeRun(first, { ...run(), actors: undefined } as unknown as NativeRun)).toBe(first);
    const newer = applyNativeRun(first, run({ revision: 2, state: "done", observation: "complete", endedAt: 20 }));
    expect(newer[0]).toMatchObject({ revision: 2, state: "done" });
    const second = applyNativeRun(newer, run({ id: "later", startedAt: 30 }));
    expect(second.map(row => row.id)).toEqual(["later", "run"]);
  });

  it("anchors only ended runs to the answer of their own turn", () => {
    const messages = [{ id: "u", turnId: "turn", role: "user", kind: "text" }, { id: "answer", turnId: "turn", role: "bot", kind: "text" }, { id: "other", turnId: "other", role: "bot", kind: "text" }];
    expect([...nativeReceiptAnchors([run()], messages).keys()]).toEqual([]);
    const ended = run({ endedAt: 40, observation: "complete", state: "done" });
    expect(nativeReceiptAnchors([ended, run({ id: "lost", turnId: "missing", endedAt: 1, observation: "complete" })], messages).get("answer")).toEqual([ended]);
  });

  it("reports a mid-turn selection change as applying to the next message", () => {
    expect(nativeExecutionComparison(run(), { instanceId: "claude-a", model: "opus" })?.status).toBe("same");
    expect(nativeExecutionComparison(run(), { instanceId: "claude-a", model: "sonnet" })).toMatchObject({ status: "next-message", running: { model: "opus", providerInstanceId: "claude-a" }, selected: { model: "sonnet" } });
    expect(nativeExecutionComparison(run(), { instanceId: "codex-b", model: "opus" })?.status).toBe("next-message");
  });

  it("claims nothing when the running facts are missing or the run is not live", () => {
    const unreported = run({ providerInstanceId: undefined, actors: [{ id: "parent", kind: "parent", label: "Main", state: "running", startedAt: 1 }] });
    expect(nativeExecutionComparison(unreported, { instanceId: "claude-a", model: "opus" })?.status).toBe("unknown");
    expect(nativeExecutionComparison(run({ observation: "complete" }), { model: "sonnet" })).toBeUndefined();
    expect(nativeExecutionComparison(run(), undefined)).toBeUndefined();
  });
});

describe("native contract manifest", () => {
  it("matches the shared sources the phone copies; regenerate with scripts/testing/native-contract-manifest.ts", () => {
    const committed = JSON.parse(readFileSync(new URL(`../${NATIVE_CONTRACT_MANIFEST}`, import.meta.url), "utf8"));
    expect(committed).toEqual(buildNativeContractManifest());
  });
});
