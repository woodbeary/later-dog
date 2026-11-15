import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { RESULT_QUIET_MS, splitResults } from "./handoff-results.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const lead = { groupId: "room", threadId: "room-chat", botId: "lead" };
const helper = (name: string) => ({ botId: name, threadId: `${name}-chat` });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

it("wakes a coordinator in a group as soon as some results are back, gives each once, and claims one row for the whole wait", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "room-results-"));
  const clock = { at: 1_000_000 };
  const pending = new Map<string, (result: HandoffRunResult) => void>();
  const wakes: { fresh: string[]; earlier: string[]; out: string[] }[] = [];
  const rows: number[] = [];
  let engine!: RoomHandoffs;
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: vi.fn(), changed: () => {},
    run: vi.fn(async (node: RoomHandoff, resumed: boolean) => {
      if (node.botId === lead.botId && resumed) {
        const split = splitResults(engine.awaited(node.id), node.startedAt);
        wakes.push({ fresh: split.fresh.map(n => n.botId), earlier: split.earlier.map(n => n.botId), out: split.out.map(n => n.botId) });
        const claimed = engine.claimSettledRow(node);
        if (claimed) rows.push(claimed.length);
        return { ok: true, text: "acted on what came back" };
      }
      return new Promise<HandoffRunResult>(resolve => pending.set(node.botId, resolve));
    }),
  };
  engine = new RoomHandoffs(join(dir, "handoffs.json"), hooks, () => clock.at);
  const settle = async () => { for (let i = 0; i < 6; i++) { engine.tick(); await flush(); } };
  const finish = (name: string) => { pending.get(name)?.({ ok: true, text: `${name} result` }); pending.delete(name); };
  try {
    for (const name of ["pip", "quill", "rook"]) engine.enqueue(lead, "turn", undefined, helper(name), name, `Lane for ${name}`);
    engine.sourceSettled("turn", true);
    await settle();
    finish("pip"); finish("quill"); await settle();
    clock.at += RESULT_QUIET_MS; await settle();
    expect(wakes).toEqual([{ fresh: ["pip", "quill"], earlier: [], out: ["rook"] }]);
    finish("rook"); await settle();
    expect(wakes.at(-1)).toEqual({ fresh: ["rook"], earlier: ["pip", "quill"], out: [] });
    expect(rows).toEqual([3]);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
  } finally { await removeTempDir(dir); }
});

