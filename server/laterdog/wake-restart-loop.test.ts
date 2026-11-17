import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoomHandoffs, ROOM_HANDOFF_LIMITS, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import { endWords } from "./handoff-budget.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const chief = { botId: "chief", threadId: "chief-chat" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

it("a coordinator wake that takes the home down every time is not re-run without end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-loop-"));
  const file = join(dir, "requests.json");
  const runs = { helper: 0, wake: 0 };
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, longWork: () => true,
    run: (node: RoomHandoff) => {
      if (node.parentId) { runs.helper++; return Promise.resolve({ ok: true, text: "done" }); }
      runs.wake++; return new Promise<HandoffRunResult>(() => {});
    },
  };
  try {
    let engine = new RoomHandoffs(file, hooks);
    engine.enqueue(chief, "turn", undefined, { botId: "scout", threadId: "scout-chat" }, "k", "Count");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 4; i++) { engine.tick(); await flush(); }
    for (let restart = 0; restart < 100; restart++) {
      engine = new RoomHandoffs(file, hooks);
      engine.tick(); await flush();
    }
    expect(runs.wake).toBeLessThan(60);
    const root = engine.nodes.get("turn")!;
    expect(root).toMatchObject({ status: "failed", endedBy: "restart" });
    expect(root.result).toBe(endWords("restart", ROOM_HANDOFF_LIMITS));
    expect(root.result).not.toMatch(/team reached its limit|Not started/);
  } finally { await removeTempDir(dir); }
});

it("one honest restart in the middle of a tree re-runs its running helper free, so the tree keeps its budget and finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "honest-restart-"));
  const file = join(dir, "requests.json");
  let firstLife = true;
  const runs: string[] = [];
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, longWork: () => true,
    run: (node: RoomHandoff) => {
      runs.push(node.parentId ? node.botId : "wake");
      if (node.botId === "slow" && firstLife) return new Promise<HandoffRunResult>(() => {});
      return Promise.resolve({ ok: true, text: `${node.botId} done` });
    },
  };
  try {
    let engine = new RoomHandoffs(file, hooks, Date.now, { executions: 2 });
    engine.enqueue(chief, "turn", undefined, { botId: "slow", threadId: "slow-chat" }, "a", "Read the long report");
    engine.enqueue(chief, "turn", undefined, { botId: "quick", threadId: "quick-chat" }, "b", "Check the date");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 4; i++) { engine.tick(); await flush(); }
    expect(engine.nodes.get("turn")?.executions).toBe(2);
    firstLife = false;
    engine = new RoomHandoffs(file, hooks, Date.now, { executions: 2 });
    for (let i = 0; i < 6; i++) { engine.tick(); await flush(); }
    const nodes = [...engine.nodes.values()];
    expect(nodes.find(n => n.botId === "slow")?.status).toBe("completed");
    expect(nodes.some(n => n.status === "failed" || n.status === "cancelled")).toBe(false);
    expect(engine.nodes.get("turn")?.executions).toBe(2);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
    expect(runs.filter(run => run === "slow")).toHaveLength(2);
  } finally { await removeTempDir(dir); }
});

