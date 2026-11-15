import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RoomHandoffs, ROOM_HANDOFF_LIMITS, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const lead = { botId: "lead", threadId: "lead-chat" };
const dog = (name: string) => ({ botId: name, threadId: `${name}-chat` });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const tell = (engine: RoomHandoffs, from: RoomHandoff, to: { botId: string; threadId: string }, text: string, reply: "none" | "result" = "none") =>
  engine.enqueue(from, "unused", from.id, to, to.botId, text, false, false, "", undefined, undefined, undefined, undefined, false, reply).node;

async function helpers(test: (engine: RoomHandoffs, hooks: RoomHandoffHooks, sent: { limit: RoomHandoff; tally: RoomHandoff }) => Promise<void> | void) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "helper-messages-"));
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false, report: vi.fn(), changed: () => {},
    run: vi.fn(async () => ({ ok: true, text: "done" })) };
  try {
    const engine = new RoomHandoffs(join(dir, "handoffs.json"), hooks);
    const limit = engine.enqueue(lead, "turn", undefined, dog("limit"), "limit", "Lane for limit").node;
    const tally = engine.enqueue(lead, "turn", undefined, dog("tally"), "tally", "Lane for tally").node;
    limit.status = "running"; tally.status = "running";
    await test(engine, hooks, { limit, tally });
  } finally { await removeTempDir(dir); }
}

it("lets a helper tell the dog above it a fact without being refused", () => helpers(async (engine, hooks, { limit }) => {
  const fact = tell(engine, limit, lead, "FYI: the two field names are settled");
  expect(fact).toMatchObject({ botId: "lead", threadId: "lead-chat", reply: "none", status: "queued" });
  engine.tick(); await flush();
  expect(hooks.run).toHaveBeenCalledWith(fact, false, expect.anything());
}));

it("still refuses a helper that hands work back up and waits for it to return", () => helpers((engine, _hooks, { limit }) => {
  expect(() => tell(engine, limit, lead, "Do my lane for me", "result")).toThrow("Cannot assign work back to an ancestor");
}));

it("lets a helper tell a sibling something either way", () => helpers((engine, _hooks, { limit }) => {
  expect(tell(engine, limit, dog("tally"), "FYI: use limitsHit").status).toBe("queued");
  expect(tell(engine, limit, dog("tally"), "Check the field names", "result").status).toBe("queued");
}));

it("ends a back-and-forth of notes at the depth limit instead of looping", () => helpers((engine, _hooks, { limit }) => {
  let from = limit;
  let notes = 0;
  const pair = [lead, dog("limit")];
  expect(() => {
    for (;;) {
      from = tell(engine, from, pair[notes % 2]!, `note ${notes}`);
      from.status = "running";
      notes++;
    }
  }).toThrow("depth limit");
  expect(notes).toBeLessThanOrEqual(ROOM_HANDOFF_LIMITS.depth);
}));

it("does not let a note to the dog above count as a result it waits for", () => helpers((engine, _hooks, { limit }) => {
  tell(engine, limit, lead, "FYI: halfway there");
  expect(engine.awaited(limit.id)).toEqual([]);
}));
