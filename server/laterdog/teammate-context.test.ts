import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { saveTeammateContext } from "./teammate-context.ts";

const source = { botId: "sender", threadId: "sender-chat" };
const target = { botId: "recipient", threadId: "recipient-chat" };
const note = (engine: RoomHandoffs, text: string, generation = "source") => engine.enqueue(source, generation, undefined,
  target, target.botId, text, false, false, "", undefined, undefined, undefined, undefined, false, "none");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(test: (engine: RoomHandoffs, hooks: RoomHandoffHooks, file: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "teammate-context-"));
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false,
    run: vi.fn(async () => ({ ok: true, text: "checked" })), report: vi.fn(), changed: vi.fn() };
  try {
    const file = join(dir, "handoffs.json");
    await test(new RoomHandoffs(file, hooks), hooks, file);
  } finally { await removeTempDir(dir); }
}

describe("teammate context without recipient turns", () => {
  it("saves several notes without occupying an idle recipient's queue or execution budget", () => fixture(async (engine, hooks) => {
    const notes = ["First note", "Second note", "Third note"].map(text => note(engine, text).node);
    engine.sourceSettled("source", true);
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(engine.queueOf(target.botId)).toEqual([]);
    expect(engine.waitingFor(target.botId)).toEqual([]);
    expect(engine.activeDirect(target.threadId)).toBe(false);
    expect(hooks.run).not.toHaveBeenCalled();
    expect(hooks.report).not.toHaveBeenCalled();
    expect(engine.pendingContext(target.botId, target.threadId)).toEqual(notes);
    expect(engine.nodes.get("source")?.executions).toBe(0);
    expect(notes.every(node => node.contextOnly && node.status === "completed")).toBe(true);
  }));

  it("keeps normal work in order while an occupied recipient collects notes", () => fixture(async (engine, hooks) => {
    let occupied = true;
    hooks.busy = node => node.botId === target.botId && occupied;
    const first = engine.enqueue(source, "first", undefined, target, "first", "First actual work").node;
    const notes = ["Context A", "Context B"].map(text => note(engine, text).node);
    const second = engine.enqueue(source, "second", undefined, target, "second", "Second actual work").node;
    for (const generation of ["first", "source", "second"]) engine.sourceSettled(generation, true);
    engine.tick(); await flush();
    expect(engine.queueOf(target.botId)).toEqual([first, second]);
    expect(hooks.run).not.toHaveBeenCalled();
    expect(engine.pendingContext(target.botId, target.threadId)).toEqual(notes);
    hooks.run = vi.fn(async node => { if (node.botId === target.botId) occupied = true; return { ok: true, text: "checked" }; });
    occupied = false; engine.tick(); await flush();
    expect(vi.mocked(hooks.run).mock.calls.filter(([node]) => node.botId === target.botId).map(([node]) => node.id)).toEqual([first.id]);
    occupied = false; engine.tick(); await flush();
    expect(vi.mocked(hooks.run).mock.calls.filter(([node]) => node.botId === target.botId).map(([node]) => node.id)).toEqual([first.id, second.id]);
  }));

  it("deduplicates a saved note and keeps an identical result-bearing request independent", () => fixture(engine => {
    const first = note(engine, "Same text");
    const repeated = note(engine, "Same text");
    const work = engine.enqueue(source, "source", undefined, target, "work", "Same text");
    expect(repeated).toEqual({ node: first.node, duplicate: true });
    expect(work.duplicate).toBe(false);
    expect(work.node.id).not.toBe(first.node.id);
    expect(engine.queueOf(target.botId)).toEqual([work.node]);
    expect(engine.pendingContext(target.botId, target.threadId)).toEqual([first.node]);
  }));

  it("keeps pending context across a restart and acknowledges the whole batch durably", () => fixture((engine, hooks, file) => {
    const notes = ["Saved A", "Saved B"].map(text => note(engine, text).node);
    engine.sourceSettled("source", true);
    const restored = new RoomHandoffs(file, hooks);
    expect(restored.pendingContext(target.botId, target.threadId).map(node => node.text)).toEqual(["Saved A", "Saved B"]);
    expect(restored.queueOf(target.botId)).toEqual([]);
    expect(restored.activeDirect(target.threadId)).toBe(false);
    restored.contextSaved(notes.map(node => node.id));
    expect(new RoomHandoffs(file, hooks).pendingContext(target.botId, target.threadId)).toEqual([]);
    expect(new RoomHandoffs(file, hooks).nodes.get(notes[0]!.id)?.contextAt).toEqual(expect.any(Number));
  }));

  it("converts never-started queued notes from an older home into passive context on restart", () => fixture((engine, hooks, file) => {
    const child = note(engine, "Older saved note").node;
    engine.sourceSettled("source", true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as RoomHandoff[];
    const legacy = saved.find(node => node.id === child.id)!;
    delete legacy.contextOnly; legacy.status = "queued"; legacy.reported = false; legacy.result = "";
    writeFileSync(file, JSON.stringify(saved));
    const restored = new RoomHandoffs(file, hooks);
    restored.tick();
    expect(restored.queueOf(target.botId)).toEqual([]);
    expect(restored.activeDirect(target.threadId)).toBe(false);
    expect(restored.pendingContext(target.botId, target.threadId).map(node => node.text)).toEqual(["Older saved note"]);
    expect(hooks.run).not.toHaveBeenCalled();
  }));

  it("isolates pending notes by recipient conversation", () => fixture(engine => {
    const here = note(engine, "Here").node;
    engine.enqueue(source, "source", undefined, { ...target, threadId: "other-chat" }, "other", "Other conversation",
      false, false, "", undefined, undefined, undefined, undefined, false, "none");
    expect(engine.pendingContext(target.botId, target.threadId)).toEqual([here]);
    expect(engine.pendingContext("another-dog", target.threadId)).toEqual([]);
  }));

  it("retries transcript placement after a partial write without repeating the saved note", () => fixture((engine, _hooks, file) => {
    const notes = ["First", "Second"].map(text => note(engine, text).node);
    engine.sourceSettled("source", true);
    const stored = new Set<string>();
    const acknowledge = vi.fn((ids: readonly string[]) => engine.contextSaved(ids));
    const append = vi.fn((node: RoomHandoff) => {
      if (node === notes[1]) throw new Error("Second transcript write interrupted");
      stored.add(node.id);
    });
    const hooks = { allowed: () => true, stored: (id: string) => stored.has(id), append, acknowledge };
    expect(() => saveTeammateContext(notes, hooks)).toThrow("Second transcript write interrupted");
    expect(acknowledge).not.toHaveBeenCalled();
    const restored = new RoomHandoffs(file, { validate: () => undefined, busy: () => false,
      run: vi.fn(async () => ({ ok: true, text: "unused" })), report: vi.fn(), changed: vi.fn() });
    const retried = vi.fn((node: RoomHandoff) => { stored.add(node.id); });
    saveTeammateContext(restored.pendingContext(target.botId, target.threadId), { ...hooks, append: retried,
      acknowledge: ids => restored.contextSaved(ids) });
    expect(retried.mock.calls.map(([node]) => node.text)).toEqual(["Second"]);
    expect(restored.pendingContext(target.botId, target.threadId)).toEqual([]);
    expect(stored.size).toBe(2);
  }));

  it("withholds notes when the source or recipient is no longer allowed", () => fixture(engine => {
    const nodes = [note(engine, "Withheld").node];
    const append = vi.fn();
    saveTeammateContext(nodes, { allowed: () => false, stored: () => false, append,
      acknowledge: ids => engine.contextSaved(ids) });
    expect(append).not.toHaveBeenCalled();
    expect(engine.pendingContext(target.botId, target.threadId)).toEqual([]);
  }));
});
