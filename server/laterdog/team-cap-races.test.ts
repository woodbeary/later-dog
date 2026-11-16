import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const chief = { botId: "chief", threadId: "chief-chat" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

it("replays tree 00f6a520: 22 requests, a wake per result and 5 restarts never cancel the long review, and the coordinator hears it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-race-"));
  const file = join(dir, "requests.json");
  let t = 1_000_000;
  let sent = 0;
  const wakes: string[][] = [];
  let truthDone: ((r: HandoffRunResult) => void) | undefined;
  let engine: RoomHandoffs;
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, longWork: () => true,
    run: (node: RoomHandoff, resumed: boolean) => {
      if (node.botId === "truth") return new Promise<HandoffRunResult>(resolve => { truthDone = resolve; });
      if (node.parentId) return Promise.resolve({ ok: true, text: `${node.botId} done` });
      wakes.push(engine.awaited(node.id).filter(c => c.givenAt === node.startedAt).map(c => c.botId));
      if (resumed && sent < 22) { sent++; engine.enqueue(chief, "turn", node.id, { botId: `h${sent}`, threadId: `h${sent}-chat` }, `k${sent}`, `Look at ${sent}`); }
      return Promise.resolve({ ok: true, text: "carry on" });
    },
  };
  try {
    engine = new RoomHandoffs(file, hooks, () => t);
    engine.enqueue(chief, "turn", undefined, { botId: "truth", threadId: "truth-chat" }, "review", "Review everything");
    sent++; engine.enqueue(chief, "turn", undefined, { botId: "h1", threadId: "h1-chat" }, "k1", "Look at 1");
    engine.sourceSettled("turn", true);
    let restarts = 0;
    for (let step = 0; step < 120; step++) {
      engine.tick(); await flush(); await flush();
      t += 16_000;
      if (step % 9 === 4 && restarts < 5) { restarts++; engine = new RoomHandoffs(file, hooks, () => t); }
    }
    for (let step = 0; step < 10; step++) { engine.tick(); await flush(); await flush(); t += 16_000; }
    const truth = [...engine.nodes.values()].find(n => n.botId === "truth")!;
    expect(restarts).toBe(5);
    expect(sent).toBe(22);
    expect(truth.status).toBe("running");
    truthDone?.({ ok: true, text: "TRUTH_DONE" });
    for (let step = 0; step < 6; step++) { engine.tick(); await flush(); await flush(); t += 16_000; }
    expect(engine.nodes.get(truth.id)?.status).toBe("completed");
    expect(wakes.at(-1)).toContain("truth");
    expect(engine.nodes.get("turn")?.status).toBe("completed");
  } finally { await removeTempDir(dir); }
});

it("a helper whose run takes the home down every time is not re-run without end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-race-"));
  const file = join(dir, "requests.json");
  let runs = 0;
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, longWork: () => true,
    run: () => { runs++; return new Promise<HandoffRunResult>(() => {}); },
  };
  try {
    let engine = new RoomHandoffs(file, hooks);
    engine.enqueue(chief, "turn", undefined, { botId: "crasher", threadId: "crasher-chat" }, "k", "Do the heavy thing");
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    for (let restart = 0; restart < 100; restart++) {
      engine = new RoomHandoffs(file, hooks);
      engine.tick(); await flush();
    }
    expect(runs).toBeLessThan(60);
  } finally { await removeTempDir(dir); }
});
