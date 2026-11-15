import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { NO_LAST_WORDS, SETTLED_BY_HOME, TURNLESS_MS } from "./turnless-requests.ts";

const lead = { botId: "lead", threadId: "lead-chat" };
const helper = (name: string) => ({ botId: name, threadId: `${name}-chat` });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Home {
  engine: RoomHandoffs;
  hooks: RoomHandoffHooks;
  clock: { at: number };
  working: Set<string>;
  finish(name: string, text?: string): void;
  settle(): Promise<void>;
  leadWakes(): number;
}

async function home(test: (h: Home) => Promise<void>) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "turnless-"));
  const clock = { at: 1_000_000 };
  const working = new Set<string>();
  const pending = new Map<string, (result: HandoffRunResult) => void>();
  let leadWakes = 0;
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: vi.fn(), changed: () => {},
    turnRunning: (node: RoomHandoff) => working.has(node.botId),
    lastWords: (node: RoomHandoff) => `${node.botId} says done`,
    run: vi.fn(async (node: RoomHandoff, resumed: boolean) => {
      if (node.botId === lead.botId && resumed) { leadWakes++; return { ok: true, text: "reviewed" }; }
      working.add(node.botId);
      return new Promise<HandoffRunResult>(resolve => pending.set(node.botId, resolve));
    }),
  };
  const engine = new RoomHandoffs(join(dir, "handoffs.json"), hooks, () => clock.at);
  try {
    await test({
      engine, hooks, clock, working, leadWakes: () => leadWakes,
      settle: async () => { for (let i = 0; i < 6; i++) { engine.tick(); await flush(); } },
      finish: (name, text = `${name} result`) => { pending.get(name)?.({ ok: true, text }); pending.delete(name); },
    });
  } finally { await removeTempDir(dir); }
}

function send(engine: RoomHandoffs, ...names: string[]): RoomHandoff[] {
  const nodes = names.map(name => engine.enqueue(lead, "turn", undefined, helper(name), name, `Lane for ${name}`).node);
  engine.sourceSettled("turn", true);
  return nodes;
}

it("settles a request whose dog has had no turn for ten minutes with what the dog last said, marked as settled by the home", () => home(async h => {
  const [pip] = send(h.engine, "pip");
  await h.settle();
  expect(pip!.status).toBe("running");
  h.working.delete("pip");
  await h.settle();
  h.clock.at += TURNLESS_MS - 1; await h.settle();
  expect(pip!.status).toBe("running");
  h.clock.at += 1; await h.settle();
  expect(pip).toMatchObject({ status: "completed", endedBy: "home", result: `${SETTLED_BY_HOME}\npip says done` });
  expect(h.hooks.report).toHaveBeenCalledWith(expect.objectContaining({ id: pip!.id }), expect.objectContaining({ id: "turn" }));
  expect(h.leadWakes()).toBe(1);
  expect(h.engine.nodes.get("turn")?.status).toBe("completed");
  h.finish("pip", "a late answer");
  await h.settle();
  expect(pip!.result).toBe(`${SETTLED_BY_HOME}\npip says done`);
  expect(h.leadWakes()).toBe(1);
}));

it("never settles a request while its dog's turn is running, however long it takes", () => home(async h => {
  const [pip] = send(h.engine, "pip");
  await h.settle();
  h.clock.at += 10 * TURNLESS_MS; await h.settle();
  expect(pip!.status).toBe("running");
  h.working.delete("pip");
  await h.settle();
  h.working.add("pip");
  h.clock.at += TURNLESS_MS; await h.settle();
  expect(pip!.status).toBe("running");
  h.finish("pip"); await h.settle();
  expect(pip).toMatchObject({ status: "completed", result: "pip result" });
  expect(pip!.endedBy).toBeUndefined();
}));

it("says so when the dog left no words", () => home(async h => {
  h.hooks.lastWords = () => undefined;
  const [pip] = send(h.engine, "pip");
  await h.settle();
  h.working.delete("pip");
  await h.settle();
  h.clock.at += TURNLESS_MS; await h.settle();
  expect(pip!.result).toBe(`${SETTLED_BY_HOME}\n${NO_LAST_WORDS}`);
}));

it("lets the dog that sent it cancel a request left running with no turn, and still refuses one that is working", () => home(async h => {
  const [pip, quill] = send(h.engine, "pip", "quill");
  await h.settle();
  h.working.delete("pip");
  expect(h.engine.cancelQueued(pip!.id, "Cancelled.")).toBe(pip);
  expect(pip).toMatchObject({ status: "cancelled", endedBy: "person" });
  expect(h.engine.cancelQueued(quill!.id, "Cancelled.")).toMatch(/already running/);
  expect(quill!.status).toBe("running");
}));

it("ends requests with no turn when the person stops the dog that sent them, and leaves working ones to report", () => home(async h => {
  const [pip, quill] = send(h.engine, "pip", "quill");
  await h.settle();
  h.engine.nodes.get("turn")!.status = "waiting";
  h.working.delete("pip");
  const left = h.engine.stopAwaitingDirect("lead-chat", "person");
  expect(left.map(n => n.id)).toEqual([quill!.id]);
  expect(pip).toMatchObject({ status: "cancelled", endedBy: "person" });
  expect(quill!.status).toBe("running");
}));

it("ends a dog's requests with no turn when it is told to stop, and none that are working", () => home(async h => {
  const [pip] = send(h.engine, "pip");
  await h.settle();
  expect(h.engine.endTurnless("pip", "pip-chat", "Stopped.", "person")).toEqual([]);
  h.working.delete("pip");
  expect(h.engine.endTurnless("pip", "pip-chat", "Stopped.", "person").map(n => n.id)).toEqual([pip!.id]);
  expect(pip).toMatchObject({ status: "cancelled", endedBy: "person", result: "Stopped." });
}));

it("leaves group requests to their own room turn", () => home(async h => {
  const node = h.engine.enqueue(lead, "turn", undefined, { groupId: "room", threadId: "room-chat", botId: "pip" }, "pip", "Lane").node;
  h.engine.sourceSettled("turn", true);
  await h.settle();
  h.working.delete("pip");
  h.clock.at += 2 * TURNLESS_MS; await h.settle();
  expect(node.status).toBe("running");
}));

