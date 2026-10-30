import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, ROOM_HANDOFF_LIMITS, type RoomHandoffHooks } from "./room-handoffs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const addr = (id: string) => ({ groupId: id, threadId: `${id}-thread`, botId: `${id}-bot` });
async function fixture(test: (engine: RoomHandoffs, hooks: RoomHandoffHooks, file: string) => Promise<void> | void, now: () => number = Date.now,
  limits: Partial<typeof ROOM_HANDOFF_LIMITS> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "room-handoff-unit-"));
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false,
    run: vi.fn(async () => ({ ok: true, text: "done" })), report: vi.fn(), changed: () => {} };
  try { const file = join(dir, "requests.json"); await test(new RoomHandoffs(file, hooks, now, limits), hooks, file); }
  finally { await removeTempDir(dir); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("addressed room request tree", () => {
  it("starts independent work before its author settles, but resumes only after settlement", () => fixture(async (engine, hooks) => {
    const source = { botId: "chief", threadId: "chief-chat" };
    const child = engine.enqueue(source, "turn", undefined, { botId: "builder", threadId: "builder-chat" }, "build", "Build it").node;
    engine.tick(); await flush(); engine.tick();
    expect(child.status).toBe("completed");
    expect(engine.nodes.get("turn")?.status).toBe("source");
    expect(hooks.run).toHaveBeenCalledTimes(1);
    engine.sourceSettled("turn", false);
    engine.tick(); await flush();
    expect(hooks.run).toHaveBeenCalledTimes(2);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
  }));
  it("names the person who drove the source as the requester of every running node in its tree, and keeps it across a reload", () => fixture(async (engine, hooks, file) => {
    const chief = { botId: "chief", threadId: "chief-chat" };
    const lead = { botId: "lead", threadId: "lead-chat" };
    const reviewer = { botId: "reviewer", threadId: "reviewer-chat" };
    const seen: Array<[string, string | undefined]> = [];
    hooks.run = vi.fn(async (node, resumed) => {
      seen.push([node.botId, engine.runningRequester(node.threadId)]);
      if (node.botId === lead.botId && !resumed) engine.enqueue(lead, "unused", node.id, reviewer, "review", "Verify it", false, false, "", undefined, "bob@example.test");
      return { ok: true, text: "done" };
    });
    engine.enqueue(chief, "turn", undefined, lead, "build", "Build it", false, false, "Build it", undefined, "ada@example.test");
    expect(engine.runningRequester(lead.threadId)).toBeUndefined();
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 8; i++) { engine.tick(); await flush(); }
    expect(seen).toEqual(expect.arrayContaining([["lead", "ada@example.test"], ["reviewer", "ada@example.test"]]));
    expect(engine.runningRequester(lead.threadId)).toBeUndefined();
    expect(new RoomHandoffs(file, hooks).nodes.get("turn")?.requestedBy).toBe("ada@example.test");
  }));
  it("hands on whose shared computers the sending turn could use with the work it sends, and keeps it across a reload", () => fixture((engine, hooks, file) => {
    const chief = { botId: "chief", threadId: "chief-chat" };
    const child = engine.enqueue(chief, "turn", undefined, { botId: "patch", threadId: "patch-chat" }, "fix", "Fix it",
      false, false, "", undefined, undefined, undefined, "cloud-home").node;
    expect(child.lender).toBe("cloud-home");
    expect(engine.nodes.get("turn")?.lender).toBeUndefined();
    expect(engine.enqueue(chief, "turn", undefined, { botId: "scout", threadId: "scout-chat" }, "look", "Look").node.lender).toBeUndefined();
    expect(new RoomHandoffs(file, hooks).nodes.get(child.id)?.lender).toBe("cloud-home");
  }));
  it("keeps same-room work queued until the current speaker settles", () => fixture(async (engine, hooks) => {
    const child = engine.enqueue(addr("A"), "turn", undefined, { ...addr("A"), botId: "peer" }, "review", "Review it").node;
    engine.tick(); await flush();
    expect(child.status).toBe("queued");
    expect(hooks.run).not.toHaveBeenCalled();
    engine.sourceSettled("turn", true); engine.tick(); await flush();
    expect(child.status).toBe("completed");
  }));
  it.each([false, true])("keeps accepted nested work when its lead fails (throws: %s)", throws => fixture(async (engine, hooks) => {
    const chief = { botId: "chief", threadId: "chief" };
    const lead = { botId: "lead", threadId: "lead" };
    hooks.run = vi.fn(async (node, resumed) => {
      if (node.botId === lead.botId && !resumed) {
        engine.enqueue(lead, "unused", node.id, { botId: "reviewer", threadId: "reviewer" }, "review", "Verify it");
        if (throws) throw new Error("Lead provider disconnected");
        return { ok: false, text: "Lead provider disconnected" };
      }
      return { ok: true, text: "Verified result" };
    });
    engine.enqueue(chief, "source", undefined, lead, "build", "Build it");
    engine.sourceSettled("source", true);
    for (let i = 0; i < 8; i++) { engine.tick(); await flush(); }
    expect([...engine.nodes.values()].every(node => node.status === "completed")).toBe(true);
    expect(hooks.run).toHaveBeenCalledTimes(4);
  }));
  it("treats group-less tasks as bounded work, deduplicates pinned threads and rejects direct or mixed cycles", () => fixture(engine => {
    const source = { botId: "clive", threadId: "clive-chat" };
    const target = { botId: "lead", threadId: "lead-task" };
    const first = engine.enqueue(source, "turn", undefined, target, "build", "Build CSV").node;
    expect(first.kind).toBe("work");
    expect(engine.enqueue(source, "turn", undefined, { ...target, threadId: "changed" }, "build", "Build CSV").node.threadId).toBe("lead-task");
    expect(engine.nodes.size).toBe(2);
    first.status = "running";
    expect(() => engine.enqueue(first, "unused", first.id, { ...source, threadId: "new-chat" }, "cycle", "repeat")).toThrow("ancestor");
    expect(() => engine.enqueue(first, "unused", first.id, { ...source, groupId: "room", threadId: "room-chat" }, "mixed", "repeat")).toThrow("ancestor");
    let parent = first;
    for (let depth = 2; depth <= ROOM_HANDOFF_LIMITS.depth; depth++) {
      parent.status = "running";
      parent = engine.enqueue(parent, "unused", parent.id, { botId: `bot-${depth}`, threadId: `task-${depth}` }, "next", "do work").node;
    }
    parent.status = "running";
    expect(() => engine.enqueue(parent, "unused", parent.id, { botId: "too-deep", threadId: "too-deep" }, "next", "do work")).toThrow("depth limit");
  }));
  it("cancels only the selected direct tree and records interruption without replay on restart", () => fixture((engine, hooks, file) => {
    const one = { botId: "clive", threadId: "one" };
    const two = { botId: "clive", threadId: "two" };
    engine.enqueue(one, "first", undefined, { botId: "lead", threadId: "lead-one" }, "work", "build");
    const other = engine.enqueue(two, "second", undefined, { botId: "lead", threadId: "lead-two" }, "work", "build").node;
    engine.cancelDirect("one");
    expect(engine.activeDirect("one")).toBe(false);
    expect(engine.activeDirect("two")).toBe(true);
    expect(other.status).toBe("queued");
    const restarted = new RoomHandoffs(file, hooks); restarted.tick();
    expect(restarted.nodes.get(other.id)?.status).toBe("failed");
    expect(restarted.nodes.get(other.id)?.result).toContain("restart");
    expect(hooks.run).not.toHaveBeenCalled();
  }));
  it("publishes only changed groups, including their final idle and cancelled states", () => fixture(async (engine, hooks) => {
    const updates: Array<{ id: string; active: boolean }[]> = [];
    hooks.changed = ids => updates.push([...ids].map(id => ({ id, active: [...engine.nodes.values()]
      .some(n => n.groupId === id && !["completed", "failed", "cancelled"].includes(n.status)) })));
    engine.enqueue(addr("Old"), "old", undefined, addr("History"), "work", "old work");
    engine.cancelRoom("Old");
    updates.length = 0;
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    engine.tick(); updates.length = 0;
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 5; i++) { engine.tick(); await flush(); }
    expect(updates.flat().every(update => ["A", "B"].includes(update.id))).toBe(true);
    expect(updates.flat()).toContainEqual({ id: "A", active: false });
    expect(updates.flat()).toContainEqual({ id: "B", active: false });
    engine.enqueue(addr("C"), "cancel", undefined, addr("D"), "work", "cancel work");
    updates.length = 0; engine.cancelRoom("C");
    expect(updates.flat()).toEqual([{ id: "D", active: false }, { id: "C", active: false }]);
  }));
  it("splits responsibility between existing members who send their own downstream work and return to the chair", () => fixture(async (engine, hooks) => {
    const member = (id: string) => ({ ...addr("A"), botId: id });
    const order: string[] = [];
    hooks.run = async (node, resumed) => {
      order.push(`${node.botId}:${resumed}`);
      if (node.kind === "assignment" && !resumed) {
        engine.enqueue(member(node.botId), "unused", node.id, addr(node.botId === "engineer" ? "B" : "C"), "downstream", "concrete task");
      }
      return { ok: true, text: `${node.botId} done` };
    };
    engine.enqueue(addr("A"), "turn", undefined, member("engineer"), "engineering", "own engineering");
    engine.enqueue(addr("A"), "turn", undefined, member("sales"), "sales", "own sales");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 12; i++) { engine.tick(); await flush(); }
    expect(engine.children("turn").map(n => n.botId)).toEqual(["engineer", "sales"]);
    expect(order).toContain("engineer:true"); expect(order).toContain("sales:true");
    expect(order.at(-1)).toBe("A-bot:true");
    expect([...engine.nodes.values()].every(n => n.status === "completed")).toBe(true);
  }));
  it("allows same-room consultation without a discussion ceremony, but refuses returning to an ancestor", () => fixture(engine => {
    const local = engine.enqueue(addr("A"), "turn", undefined, { ...addr("A"), botId: "owner" }, "own", "Review the plan").node;
    expect(local.kind).toBe("assignment");
    local.status = "running";
    expect(() => engine.enqueue(local, "unused", local.id, addr("A"), "loop", "task")).toThrow("ancestor");
  }));
  it("deduplicates retries and pins the destination thread", () => fixture(engine => {
    const first = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "csv", "build");
    const again = engine.enqueue(addr("A"), "turn", undefined, { ...addr("B"), threadId: "new-active" }, "csv", "build");
    expect(again.duplicate).toBe(true); expect(again.node.id).toBe(first.node.id); expect(again.node.threadId).toBe("B-thread");
  }));
  it("retains the original request while descendants work and bounds its stored length", () => fixture(engine => {
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build", false, false, "original request");
    expect(engine.nodes.get("turn")?.text).toBe("original request");
    engine.enqueue(addr("A"), "turn", undefined, addr("C"), "review", "check", false, false, "later brief");
    expect(engine.nodes.get("turn")?.text).toBe("original request");
    engine.enqueue(addr("X"), "other", undefined, addr("Y"), "work", "build", false, false, "x".repeat(20_000));
    expect(engine.nodes.get("other")?.text).toHaveLength(12_000);
  }));
  it("starts independent children immediately, then returns and resumes both ancestors", () => fixture(async (engine, hooks) => {
    const order: string[] = [];
    hooks.run = async (node, resumed) => {
      order.push(`${node.groupId}:${resumed}`);
      if (node.groupId === "B" && !resumed) engine.enqueue(addr("B"), "ignored", node.id, addr("C"), "implementation", "build CSV");
      return { ok: true, text: `${node.groupId} done` };
    };
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "develop", "build");
    engine.tick(); expect(order).toEqual(["B:false", "C:false"]);
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 12; i++) { engine.tick(); await flush(); }
    expect(order).toEqual(["B:false", "C:false", "B:true", "A:true"]);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
    expect(hooks.report).toHaveBeenCalledTimes(2);
  }));
  it("rejects accidental acknowledgements as new work while allowing retries and explicit additional work", () => fixture(engine => {
    const completed = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build").node;
    completed.status = "completed";
    expect(engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build").duplicate).toBe(true);
    expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("B"), "ack", "approved")).toThrow("already completed");
    expect(engine.enqueue(addr("A"), "turn", undefined, addr("B"), "fix", "Fix the missing boundary case", false, true).node.status).toBe("queued");
    const rerun = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build", false, true);
    expect(rerun.duplicate).toBe(false);
    expect(engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build", false, true)).toEqual({ node: rerun.node, duplicate: true });
  }));
  it("resumes the parent only after all sibling results have been delivered", () => fixture(async (engine, hooks) => {
    const delivered: string[] = [];
    let finishSlow!: (result: { ok: boolean; text: string }) => void;
    const resumed: string[][] = [];
    hooks.report = child => { delivered.push(child.groupId!); };
    hooks.run = async (node, resume) => {
      if (resume) resumed.push([...delivered]);
      if (node.groupId === "C") return new Promise(resolve => { finishSlow = resolve; });
      return { ok: true, text: `${node.groupId} done` };
    };
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "fast", "build");
    engine.enqueue(addr("A"), "turn", undefined, addr("C"), "slow", "check");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(delivered).toEqual(["B"]); expect(resumed).toEqual([]);
    finishSlow({ ok: true, text: "C done" }); await flush();
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(resumed).toEqual([["B", "C"]]);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
  }));
  it("blocks ancestor loops and forged parents", () => fixture(engine => {
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    node.status = "running";
    expect(() => engine.enqueue(addr("B"), "t2", node.id, addr("A"), "loop", "again")).toThrow("ancestor");
    expect(() => engine.enqueue(addr("X"), "t2", node.id, addr("C"), "spoof", "again")).toThrow("speaker");
    expect(() => engine.enqueue(addr("B"), "t2", "missing", addr("C"), "missing", "again")).toThrow("no longer running");
  }));
  it("bounds fan-out and depth across the entire root", () => fixture(engine => {
    for (let i = 0; i < ROOM_HANDOFF_LIMITS.requests; i++) engine.enqueue(addr("A"), "turn", undefined, addr(`B${i}`), `work${i}`, "build");
    expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("X"), "overflow", "build")).toThrow("budget");
    let source = addr("root2"); let parentId: string | undefined;
    for (let i = 0; i < ROOM_HANDOFF_LIMITS.depth; i++) {
      const { node } = engine.enqueue(source, "second-root", parentId, addr(`depth${i}`), "work", "build");
      node.status = "running"; source = addr(`depth${i}`); parentId = node.id;
    }
    expect(() => engine.enqueue(source, "second-root", parentId, addr("too-deep"), "work", "build")).toThrow("depth");
  }));
  it("retains accepted work when its source fails but never runs a revoked route", () => fixture(async (engine, hooks) => {
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    engine.sourceSettled("turn", false); engine.tick(); await flush();
    expect(hooks.run).toHaveBeenCalledTimes(1);
    const { node } = engine.enqueue(addr("C"), "turn2", undefined, addr("D"), "work", "build");
    engine.sourceSettled("turn2", true);
    hooks.validate = n => n.id === node.id ? "route revoked" : undefined;
    engine.tick(); await flush(); expect(node.status).toBe("failed"); expect(node.result).toContain("revoked");
  }));
  it("retains busy work and aborts an executing child when the source is stopped", () => fixture(async (engine, hooks) => {
    let aborted = false;
    hooks.busy = () => true;
    hooks.run = (_n, _r, signal) => new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false, text: "stopped" }); }));
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    engine.sourceSettled("turn", true); engine.tick(); expect(node.status).toBe("queued");
    hooks.busy = () => false; engine.tick(); expect(node.status).toBe("running");
    engine.cancelRoom("A"); await flush(); expect(aborted).toBe(true); expect(node.status).toBe("cancelled");
  }));
  it("names the conversation waiting on a teammate's direct thread until that work settles", () => fixture(async (engine, hooks) => {
    const source = { botId: "clive", threadId: "clive-chat" };
    let finish!: (result: { ok: boolean; text: string }) => void;
    hooks.run = () => new Promise(resolve => { finish = resolve; });
    const node = engine.enqueue(source, "turn", undefined, { botId: "lead", threadId: "lead-task" }, "build", "Build the CSV export").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    expect(node.status).toBe("running");
    expect(engine.assignerOf("lead-task")).toMatchObject({ botId: "clive", threadId: "clive-chat" });
    expect(engine.assignerOf("clive-chat")).toBeUndefined();

    finish({ ok: true, text: "done" });
    await flush();
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(engine.assignerOf("lead-task")).toBeUndefined();
  }));
  it("stops a conversation without aborting the teammate already working, and drops only what had not started", () => fixture(async (engine, hooks) => {
    const source = { botId: "clive", threadId: "clive-chat" };
    const runs: Array<{ id: string; resumed: boolean }> = [];
    let finish!: (result: { ok: boolean; text: string }) => void;
    let aborted = false;
    hooks.busy = node => node.botId === "reviewer";
    hooks.run = (node, resumed, signal) => {
      runs.push({ id: node.id, resumed });
      return new Promise(resolve => {
        signal.addEventListener("abort", () => { aborted = true; });
        finish = resolve;
      });
    };
    const running = engine.enqueue(source, "turn", undefined, { botId: "lead", threadId: "lead-task" }, "build", "Build the CSV export").node;
    const queued = engine.enqueue(source, "turn", undefined, { botId: "reviewer", threadId: "reviewer-task" }, "review", "Review the CSV export").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    expect(running.status).toBe("running");
    expect(queued.status).toBe("queued");
    expect(engine.outstandingDirect("clive-chat").map(node => node.botId)).toEqual(["lead", "reviewer"]);

    const left = engine.stopAwaitingDirect("clive-chat");
    expect(left.map(node => node.id)).toEqual([running.id]);
    expect(aborted).toBe(false);
    expect(running.status).toBe("running");
    expect(queued.status).toBe("cancelled");
    expect(engine.nodes.get("turn")?.status).toBe("cancelled");
    expect(engine.activeDirect("clive-chat")).toBe(false);
    expect(engine.outstandingDirect("clive-chat").map(node => node.botId)).toEqual(["lead"]);

    finish({ ok: true, text: "CSV export delivered" });
    await flush();
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(running.status).toBe("completed");
    expect(running.result).toBe("CSV export delivered");
    expect((hooks.report as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].id)).toContain(running.id);
    expect(runs.map(run => run.id)).toEqual([running.id]);
  }));
  it("records interruption on restart without replaying side effects and fails closed on corrupt storage", () => fixture((engine, hooks, file) => {
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    const restarted = new RoomHandoffs(file, hooks); restarted.tick();
    expect(restarted.nodes.get(node.id)?.result).toContain("restart"); expect(hooks.run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf8")).every((n: { status: string }) => n.status === "failed")).toBe(true);
    writeFileSync(file, "{corrupt");
    expect(() => new RoomHandoffs(file, hooks).enqueue(addr("A"), "new", undefined, addr("B"), "work", "build")).toThrow("storage");
  }));
});

const MIN = 60_000;
const settle = async (engine: RoomHandoffs, times = 4) => { for (let i = 0; i < times; i++) { engine.tick(); await flush(); } };
type Finish = (result: { ok: boolean; text: string }) => void;

describe("room handoff idle budget", () => {
  it("keeps a tree alive for hours while its dog keeps showing activity, then says plainly that time ran out", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      let aborted = false;
      hooks.activity = () => ({ at: nowMs });
      hooks.run = (_node, _resumed, signal) => new Promise(resolve =>
        signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false, text: "aborted" }); }));
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      for (nowMs = 10 * MIN; nowMs < 4 * 60 * MIN; nowMs += 10 * MIN) { engine.tick(); await flush(); expect(node.status).toBe("running"); }
      nowMs = 4 * 60 * MIN - 1_000; engine.tick(); await flush();
      expect(node.status).toBe("running");
      nowMs = 4 * 60 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("failed");
      expect(node.endedBy).toBe("capped");
      expect(node.result).toContain("Ran out of time after 4 hours.");
      expect(node.result).not.toMatch(/user|stopped by/i);
      expect(aborted).toBe(true);
    }, () => nowMs);
  });
  it("stops waiting once a running node has shown nothing for the idle window, and says so", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.activity = () => ({ at: 0 });
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = ROOM_HANDOFF_LIMITS.idleMs; engine.tick(); await flush();
      expect(node.status).toBe("running");
      nowMs = ROOM_HANDOFF_LIMITS.idleMs + 1; engine.tick(); await flush();
      expect(node.status).toBe("failed");
      expect(node.endedBy).toBe("idle");
      expect(node.result).toContain("Nothing moved for 20 minutes");
      expect(engine.nodes.get("turn")?.endedBy).toBe("idle");
    }, () => nowMs);
  });
  it("renews the idle window every time the dog shows activity", async () => {
    let nowMs = 0;
    let lastActivity = 0;
    await fixture(async (engine, hooks) => {
      hooks.activity = () => ({ at: lastActivity });
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 19 * MIN; lastActivity = nowMs; engine.tick(); await flush();
      nowMs = 38 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("running");
      nowMs = 39 * MIN + 1; engine.tick(); await flush();
      expect(node.status).toBe("failed");
      expect(node.endedBy).toBe("idle");
    }, () => nowMs);
  });
  it("never counts time spent waiting on the person as idle", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.activity = () => ({ at: 0, waiting: true });
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 3 * 60 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("running");
    }, () => nowMs);
  });
  it("trusts a running node it has no activity reading for, up to the hard cap", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 3 * 60 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("running");
    }, () => nowMs);
  });
  it("keeps queued work waiting for a busy teammate alive, then ends it as out of time at the hard cap", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.busy = () => true;
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = 2 * 60 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("queued");
      expect(engine.nodes.get("turn")?.status).toBe("waiting");
      nowMs = 4 * 60 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("failed");
      expect(node.endedBy).toBe("capped");
      expect(node.result).toBe("Ran out of time after 4 hours.");
      expect(hooks.run).not.toHaveBeenCalled();
    }, () => nowMs);
  });
  it("refuses new work in plain words once too little time is left to use it", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 3 * 60 * MIN;
      expect(() => engine.enqueue(node, "follow", node.id, addr("C"), "work", "more")).not.toThrow();
      nowMs = 4 * 60 * MIN - 9 * MIN;
      expect(() => engine.enqueue(node, "follow", node.id, addr("D"), "work", "even more"))
        .toThrow(/Time is nearly up for this team task: 9 minutes left of 4 hours.*tell the person plainly/);
    }, () => nowMs);
  });
  it("lets a parent that only owes a synthesis finish past the cap, then completes the tree", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const finish: Record<string, Finish> = {};
      hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = 11 * MIN; engine.tick(); await flush();
      finish.work({ ok: true, text: "child done" }); await flush();
      hooks.busy = n => n.id === "turn";
      await settle(engine, 2);
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("resume");
      nowMs = 27 * MIN; hooks.busy = () => false;
      engine.tick(); await flush();
      expect(parent.status).toBe("running");
      finish.root({ ok: true, text: "synthesized" }); await flush();
      engine.tick(); await flush();
      expect(parent.status).toBe("completed");
      expect(hooks.report).toHaveBeenCalled();
    }, () => nowMs, { minRunwayMs: 5 * MIN, hardCapMs: 15 * MIN });
  });
  it("still ends a true stall past the cap when the owed synthesis cannot run", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const finish: Record<string, Finish> = {};
      hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = 11 * MIN; engine.tick(); await flush();
      finish.work({ ok: true, text: "child done" }); await flush();
      hooks.busy = () => true;
      await settle(engine, 2);
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("resume");
      nowMs = 27 * MIN; engine.tick(); await flush();
      expect(parent.status).toBe("failed");
      expect(parent.endedBy).toBe("capped");
      expect(parent.result).toContain("Ran out of time after 15 minutes.");
      expect(node.status).toBe("completed");
    }, () => nowMs, { minRunwayMs: 5 * MIN, hardCapMs: 15 * MIN });
  });
  it("bounds an in-flight synthesis past the cap to its minimum runway", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      let aborted = false;
      const finish: Record<string, Finish> = {};
      hooks.run = (node, _resumed, signal) => new Promise(resolve => {
        finish[node.key] = resolve;
        signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false, text: "aborted" }); });
      });
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = 13 * MIN; engine.tick(); await flush();
      finish.work({ ok: true, text: "child done" }); await flush();
      hooks.busy = n => n.id === "turn";
      await settle(engine, 2);
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("resume");
      nowMs = 14 * MIN; hooks.busy = () => false;
      engine.tick(); await flush();
      expect(parent.status).toBe("running");
      nowMs = 16 * MIN; engine.tick(); await flush();
      expect(parent.status).toBe("running");
      expect(aborted).toBe(false);
      nowMs = 14 * MIN + 5 * MIN + 1_000; engine.tick(); await flush();
      expect(parent.status).toBe("failed");
      expect(aborted).toBe(true);
      expect(parent.endedBy).toBe("capped");
      expect(node.status).toBe("completed");
    }, () => nowMs, { minRunwayMs: 5 * MIN, hardCapMs: 15 * MIN });
  });
  it("persists the progress stamp and the ending, and reloads them", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks, file) => {
      const finish: Record<string, Finish> = {};
      hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 40 * MIN; finish.work({ ok: true, text: "child done" }); await flush();
      await settle(engine, 2);
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("running");
      nowMs = 42 * MIN; finish.root({ ok: true, text: "synthesized" }); await flush();
      engine.tick(); await flush();
      expect(parent.status).toBe("completed");
      const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; lastProgressAt?: number }>;
      expect(saved.find(n => n.id === "turn")?.lastProgressAt).toBe(42 * MIN);
      expect(new RoomHandoffs(file, hooks, () => nowMs).nodes.get("turn")?.lastProgressAt).toBe(42 * MIN);
    }, () => nowMs);
  });
});

describe("room handoff endings tell the truth", () => {
  const stopped = (engine: RoomHandoffs, thread: string) => [...engine.nodes.values()].filter(n => n.threadId === thread);
  it("says the person stopped it only when the person did", () => fixture(engine => {
    engine.enqueue(addr("Old"), "old", undefined, addr("History"), "work", "old work");
    engine.cancelRoom("Old");
    for (const n of engine.nodes.values()) {
      if (n.status === "cancelled") { expect(n.endedBy).toBe("person"); expect(n.result).toBe("The person stopped this work."); }
    }
    expect(engine.nodes.get("old")?.status).toBe("cancelled");
  }));
  it("labels an interruption, a deleted conversation and a restart as what they were", () => fixture((engine, hooks, file) => {
    const one = { botId: "clive", threadId: "one" };
    const two = { botId: "clive", threadId: "two" };
    const three = { botId: "clive", threadId: "three" };
    const a = engine.enqueue(one, "first", undefined, { botId: "lead", threadId: "lead-one" }, "work", "build").node;
    const b = engine.enqueue(two, "second", undefined, { botId: "lead", threadId: "lead-two" }, "work", "build").node;
    const c = engine.enqueue(three, "third", undefined, { botId: "lead", threadId: "lead-three" }, "work", "build").node;
    engine.cancelDirect("one", "deleted");
    expect(a.endedBy).toBe("deleted");
    expect(a.result).toBe("The conversation that asked for this was deleted.");
    engine.stopAwaitingDirect("two", "interrupted");
    expect(stopped(engine, "two").some(n => n.endedBy === "interrupted")).toBe(true);
    expect(engine.nodes.get("second")?.result).toBe("Interrupted before it finished.");
    expect(b.endedBy).toBe("interrupted");
    expect(b.result).toBe("Interrupted before it started.");
    const restarted = new RoomHandoffs(file, hooks);
    expect(restarted.nodes.get(c.id)?.endedBy).toBe("restart");
    expect(restarted.nodes.get(c.id)?.result).toContain("restarted");
    expect(restarted.nodes.get(c.id)?.result).not.toMatch(/user/i);
  }));
  it("stops a person-stopped teammate that never started as stopped before it started", () => fixture(engine => {
    const { node } = engine.enqueue({ botId: "clive", threadId: "one" }, "turn", undefined, { botId: "lead", threadId: "lead" }, "work", "build");
    engine.sourceSettled("turn", true);
    engine.nodes.get("turn")!.status = "running";
    engine.stopAwaitingDirect("one");
    expect(node.status).toBe("cancelled");
    expect(node.endedBy).toBe("person");
    expect(node.result).toBe("The person stopped this before it started.");
  }));
  it("ends queued work whose originating request has ended as never started, not stopped", () => fixture(engine => {
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    engine.nodes.get("turn")!.status = "completed";
    engine.tick();
    expect(node.status).toBe("cancelled");
    expect(node.endedBy).toBe("origin");
  }));
});

describe("room handoff continue", () => {
  async function timedOut(engine: RoomHandoffs, hooks: RoomHandoffHooks, setNow: (ms: number) => void) {
    const finish: Record<string, Finish> = {};
    hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
    const source = { botId: "chief", threadId: "chief-chat" };
    const done = engine.enqueue(source, "turn", undefined, { botId: "scout", threadId: "scout-work" }, "scout", "Find the files").node;
    const slow = engine.enqueue(source, "turn", undefined, { botId: "builder", threadId: "builder-work" }, "builder", "Build it").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    finish.scout({ ok: true, text: "Found them" }); await flush();
    setNow(ROOM_HANDOFF_LIMITS.hardCapMs); engine.tick(); await flush();
    return { done, slow, source };
  }
  it("offers Continue once when a tree ends for time, and not for a person's stop", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const closed = vi.fn(); hooks.closed = closed;
      const { slow } = await timedOut(engine, hooks, ms => { nowMs = ms; });
      expect(slow.endedBy).toBe("capped");
      engine.tick(); engine.tick();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledWith(expect.objectContaining({ id: "turn", endedBy: "capped" }), "capped");
      engine.enqueue(addr("Z"), "stop", undefined, addr("Y"), "work", "build");
      engine.cancelRoom("Z");
      engine.tick();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(engine.continuable("stop")).toBe(false);
    }, () => nowMs);
  });
  it("resumes the same work: finished answers carry over and only the unfinished request goes out again", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const { slow, done, source } = await timedOut(engine, hooks, ms => { nowMs = ms; });
      expect(engine.continuable("turn")).toBe(true);
      hooks.run = vi.fn(async node => ({ ok: true, text: `${node.key} finished` }));
      nowMs += MIN;
      slow.lender = "cloud-home";
      const result = engine.continueTree("turn");
      expect(result).toMatchObject({ resent: 1, kept: 1 });
      const root = engine.nodes.get(result.rootId)!;
      expect(root).toMatchObject({ botId: "chief", threadId: "chief-chat", text: engine.nodes.get("turn")!.text });
      const copies = engine.children(root.id);
      expect(copies.map(n => [n.key, n.status])).toEqual(expect.arrayContaining([["scout", "completed"], ["builder", "queued"]]));
      const again = copies.find(n => n.key === "builder")!;
      expect(again.threadId).toBe(slow.threadId);
      expect(again.text).toContain("Build it");
      expect(again.text).toContain("Continuing");
      expect(again.lender).toBe("cloud-home");
      expect(copies.find(n => n.key === "scout")?.result).toBe(done.result);
      expect(engine.nodes.get("turn")?.continuedAs).toBe(root.id);
      expect(engine.continuable("turn")).toBe(false);
      expect(() => engine.continueTree("turn")).toThrow("already continued");
      await settle(engine, 8);
      expect(engine.nodes.get(result.rootId)?.status).toBe("completed");
      expect(hooks.run).toHaveBeenCalledWith(expect.objectContaining({ key: "builder" }), false, expect.anything());
      expect(hooks.run).toHaveBeenCalledWith(expect.objectContaining({ id: result.rootId }), true, expect.anything());
      expect(source.botId).toBe("chief");
    }, () => nowMs);
  });
  it("refuses to continue work that was not cut short by time", () => fixture(engine => {
    engine.enqueue(addr("Q"), "turn", undefined, addr("R"), "work", "build");
    engine.cancelRoom("Q");
    expect(() => engine.continueTree("turn")).toThrow("Nothing is waiting");
    expect(() => engine.continueTree("missing")).toThrow("no such work");
  }));
  it("leaves the old tree untouched when a continuation cannot be queued", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      await timedOut(engine, hooks, ms => { nowMs = ms; });
      const before = engine.nodes.size;
      hooks.validate = () => "A teammate is no longer reachable";
      expect(() => engine.continueTree("turn")).toThrow("no longer reachable");
      expect(engine.nodes.size).toBe(before);
      expect(engine.nodes.get("turn")?.continuedAs).toBeUndefined();
    }, () => nowMs);
  });
});

describe("room handoff time-out digest", () => {
  it("carries a bounded digest of settled children when time runs out", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const finish: Record<string, Finish> = {};
      hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
      hooks.busy = n => n.id === "turn";
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.enqueue(addr("A"), "turn", undefined, addr("C"), "more", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 5 * MIN;
      finish.work({ ok: true, text: "alpha result TAIL-END" });
      finish.more({ ok: true, text: "beta result TAIL-END" }); await flush();
      await settle(engine, 2);
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("resume");
      nowMs = 51 * MIN; engine.tick(); await flush();
      expect(parent.status).toBe("failed");
      expect(parent.result).toContain("Ran out of time after 45 minutes.");
      expect(parent.result).toContain("work [completed] alpha result TAIL-END");
      expect(parent.result).toContain("more [completed] beta result TAIL-END");
      expect(parent.result.length).toBeLessThan(5000);
    }, () => nowMs, { hardCapMs: 45 * MIN });
  });
  it("elides digest entries beyond the budget", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const finish: Record<string, Finish> = {};
      hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
      hooks.busy = n => n.id === "turn";
      for (let i = 0; i < 12; i++) engine.enqueue(addr("A"), "turn", undefined, addr(`B${i}`), `work${i}`, "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 5 * MIN;
      for (let i = 0; i < 12; i++) finish[`work${i}`]({ ok: true, text: "x".repeat(2048) });
      await flush();
      await settle(engine, 2);
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("resume");
      nowMs = 51 * MIN; engine.tick(); await flush();
      expect(parent.status).toBe("failed");
      expect(parent.result).toContain("Ran out of time after 45 minutes.");
      expect(parent.result).toContain("elided)");
      expect(parent.result.length).toBeLessThan(5000);
    }, () => nowMs, { hardCapMs: 45 * MIN });
  });
  it("adds no digest when nothing settled", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = 46 * MIN; engine.tick(); await flush();
      expect(node.status).toBe("failed");
      expect(node.result).toBe("Ran out of time after 45 minutes.");
    }, () => nowMs, { hardCapMs: 45 * MIN });
  });
});


describe("shared room request display", () => {
  it("shares one identity across one call's recipients, before and after dispatch and restart", () => fixture(async (engine, hooks, file) => {
    const source = addr("A");
    const one = engine.enqueue(source, "turn", undefined, addr("B"), "work:b", "Review", false, false, "", "work").node;
    const two = engine.enqueue(source, "turn", undefined, { ...addr("B"), botId: "c" }, "work:c", "Review", false, false, "", "work").node;
    expect(engine.sharedRequest(one)).toEqual({ id: one.id, botIds: [one.botId, two.botId] });
    expect(engine.sharedRequest(two)).toEqual(engine.sharedRequest(one));
    engine.tick();
    expect(one.status).toBe("running");
    expect(one.startedAt).toBeDefined();
    await flush();
    expect(one.status).toBe("completed");
    expect(one.executions).toBe(0);
    expect(engine.enqueue(source, "turn", undefined, addr("B"), "work:b", "Review", false, false, "", "work").duplicate).toBe(true);
    const restarted = new RoomHandoffs(file, hooks);
    expect(restarted.sharedRequest(restarted.nodes.get(two.id)!)).toEqual(engine.sharedRequest(two));
    expect(restarted.sharedRequest(restarted.nodes.get(one.id)!)).toEqual({ id: one.id, botIds: [one.botId, two.botId] });
  }));
  it("does not merge different requests, conversations, senders or direct assignments", () => fixture(engine => {
    const a = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "one:b", "Review", false, false, "", "one").node;
    const b = engine.enqueue(addr("A"), "turn", undefined, { ...addr("B"), botId: "c" }, "two:c", "Review", false, false, "", "two").node;
    const c = engine.enqueue(addr("A"), "other-turn", undefined, addr("B"), "one:b", "Review", false, false, "", "one").node;
    const d = engine.enqueue(addr("A"), "turn", undefined, addr("D"), "one:d", "Review", false, false, "", "one").node;
    const direct = engine.enqueue(addr("A"), "turn", undefined, { botId: "direct", threadId: "direct" }, "one:direct", "Review").node;
    for (const node of [a,b,c,d,direct]) expect(engine.sharedRequest(node)).toEqual({ id: node.id, botIds: [node.botId] });
  }));
});

describe("long work for the owner's auto dogs", () => {
  const chief = { botId: "chief", threadId: "chief-chat" };
  const builder = { botId: "builder", threadId: "builder-work" };
  const scout = { botId: "scout", threadId: "scout-work" };

  it("keeps working past the 4-hour cap while the dogs are busy, then stops at 12 hours with one plain line", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      let reason: unknown;
      const closed = vi.fn();
      hooks.longWork = () => true;
      hooks.closed = closed;
      hooks.activity = () => ({ at: nowMs });
      hooks.run = (_node, _resumed, signal) => new Promise(resolve =>
        signal.addEventListener("abort", () => { reason = signal.reason; resolve({ ok: false, text: "aborted" }); }));
      const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
      engine.sourceSettled("turn", true);
      for (nowMs = 10 * MIN; nowMs < 12 * 60 * MIN; nowMs += 10 * MIN) { engine.tick(); await flush(); expect(node.status).toBe("running"); }
      nowMs = 12 * 60 * MIN; engine.tick(); await flush(); engine.tick();
      expect(node).toMatchObject({ status: "failed", endedBy: "ceiling" });
      expect(node.result).toContain("Stopped after 12 hours");
      expect(reason).toBe("ceiling");
      expect(closed).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledWith(expect.objectContaining({ id: "turn", endedBy: "ceiling" }), "ceiling");
      expect(engine.continuable("turn")).toBe(false);
    }, () => nowMs);
  });

  it("never waits for Continue: a tree where nothing moved picks itself back up", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const closed = vi.fn();
      const continued = vi.fn();
      const runs: Array<{ key: string; text: string }> = [];
      hooks.longWork = () => true;
      hooks.closed = closed;
      hooks.continued = continued;
      hooks.activity = () => ({ at: 0 });
      hooks.run = (node, resumed) => {
        runs.push({ key: node.key, text: node.text });
        return resumed || node.text.includes("Continuing") ? Promise.resolve({ ok: true, text: `${node.key} done` }) : new Promise(() => {});
      };
      const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = ROOM_HANDOFF_LIMITS.idleMs + 1; engine.tick(); await flush();
      expect(node.endedBy).toBe("idle");
      const old = engine.nodes.get("turn")!;
      expect(old.continuedAs).toBeDefined();
      expect(continued).toHaveBeenCalledWith(expect.objectContaining({ id: "turn" }),
        expect.objectContaining({ id: old.continuedAs, firstCreatedAt: 0 }), "idle");
      hooks.activity = () => ({ at: nowMs });
      await settle(engine, 8);
      expect(engine.nodes.get(old.continuedAs!)?.status).toBe("completed");
      expect(runs.filter(run => run.key === "build").map(run => run.text.includes("Continuing"))).toEqual([false, true]);
      expect(closed).not.toHaveBeenCalled();
    }, () => nowMs);
  });

  it("keeps the 4-hour cap and the Continue offer when any dog in the tree is not the owner's auto dog", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      let reason: unknown;
      const closed = vi.fn();
      hooks.longWork = node => node.botId !== "scout";
      hooks.closed = closed;
      hooks.activity = () => ({ at: nowMs });
      hooks.run = (_node, _resumed, signal) => new Promise(resolve =>
        signal.addEventListener("abort", () => { reason = signal.reason; resolve({ ok: false, text: "aborted" }); }));
      const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
      engine.enqueue(chief, "turn", undefined, scout, "scout", "Find it");
      engine.sourceSettled("turn", true);
      nowMs = 4 * 60 * MIN - 1_000; engine.tick(); await flush();
      expect(node.status).toBe("running");
      nowMs = 4 * 60 * MIN; engine.tick(); await flush();
      expect(node).toMatchObject({ status: "failed", endedBy: "capped" });
      expect(reason).toBe("capped");
      expect(closed).toHaveBeenCalledWith(expect.objectContaining({ id: "turn" }), "capped");
      expect(engine.continuable("turn")).toBe(true);
    }, () => nowMs);
  });

  it("tries a timed-out turn once more with a note, and names a second timeout as running out of time", () => fixture(async (engine, hooks) => {
    const seen: Array<boolean | undefined> = [];
    hooks.run = vi.fn(async (node, resumed) => {
      if (resumed) return { ok: true, text: "reviewed" };
      seen.push(node.retried);
      return { ok: false, text: "Builder's turn ran out of time.", timedOut: true };
    });
    const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
    engine.sourceSettled("turn", true);
    await settle(engine, 8);
    expect(seen).toEqual([undefined, true]);
    expect(node).toMatchObject({ status: "failed", endedBy: "timeout" });
    expect(node.result).toBe("Builder's turn ran out of time. It was tried again and ran out of time again.");
    expect(node.result).not.toMatch(/user|stopped by/i);
    expect(hooks.report).toHaveBeenCalledWith(expect.objectContaining({ id: node.id, endedBy: "timeout" }), expect.anything());
  }));

  it("finishes normally when the retry of a timed-out turn succeeds", () => fixture(async (engine, hooks) => {
    let calls = 0;
    hooks.run = vi.fn(async (_node, resumed) => {
      if (resumed) return { ok: true, text: "reviewed" };
      calls++;
      return calls === 1 ? { ok: false, text: "timed out", timedOut: true } : { ok: true, text: "built" };
    });
    const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
    engine.sourceSettled("turn", true);
    await settle(engine, 8);
    expect(node).toMatchObject({ status: "completed", result: "built", retried: true });
    expect(engine.nodes.get("turn")?.status).toBe("completed");
  }));

  it("still ends a plain failure at once, without a retry", () => fixture(async (engine, hooks) => {
    hooks.run = vi.fn(async (_node, resumed) => resumed ? { ok: true, text: "reviewed" } : { ok: false, text: "Provider refused" });
    const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
    engine.sourceSettled("turn", true);
    await settle(engine, 6);
    expect(node).toMatchObject({ status: "failed", endedBy: "problem", result: "Provider refused" });
    expect((hooks.run as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0].id === node.id)).toHaveLength(1);
  }));

  it("picks the owner's auto work back up after a restart and says so once", () => fixture(async (engine, hooks, file) => {
    hooks.run = () => new Promise(() => {});
    hooks.busy = node => node.botId === "scout";
    const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
    const waiting = engine.enqueue(chief, "turn", undefined, scout, "scout", "Find it").node;
    engine.tick(); await flush();
    expect(node.status).toBe("running");
    expect(waiting.status).toBe("queued");
    const restartedLine = vi.fn();
    const runs: Array<{ key: string; restarted?: boolean; resumed: boolean }> = [];
    const after: RoomHandoffHooks = {
      ...hooks, busy: () => false, longWork: () => true, restarted: restartedLine,
      run: vi.fn(async (n, resumed) => { runs.push({ key: n.key, restarted: n.restarted, resumed }); return { ok: true, text: `${n.key} done` }; }),
    };
    const restarted = new RoomHandoffs(file, after);
    expect(restarted.nodes.get(node.id)?.status).toBe("running");
    await settle(restarted, 8);
    expect(restartedLine).toHaveBeenCalledTimes(1);
    expect(restartedLine).toHaveBeenCalledWith(expect.objectContaining({ id: "turn" }),
      expect.arrayContaining([expect.objectContaining({ id: node.id }), expect.objectContaining({ id: waiting.id })]), true);
    expect(runs).toEqual(expect.arrayContaining([
      { key: "build", restarted: true, resumed: false },
      { key: "scout", restarted: undefined, resumed: false },
      { key: "root", restarted: undefined, resumed: true },
    ]));
    expect(restarted.nodes.get(node.id)).toMatchObject({ status: "completed", restarted: undefined });
    expect(restarted.nodes.get("turn")?.status).toBe("completed");
  }));

  it("does not replay anyone else's work after a restart, and reports it to the coordinator as before", () => fixture(async (engine, hooks, file) => {
    hooks.run = () => new Promise(() => {});
    const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it");
    const other = engine.enqueue(chief, "turn", undefined, scout, "scout", "Find it").node;
    engine.tick(); await flush();
    const restartedLine = vi.fn();
    const after: RoomHandoffHooks = { ...hooks, longWork: () => false, restarted: restartedLine, report: vi.fn(), run: vi.fn() };
    const restarted = new RoomHandoffs(file, after);
    await settle(restarted, 4);
    for (const id of [node.id, other.id, "turn"]) expect(restarted.nodes.get(id)).toMatchObject({ status: "failed", endedBy: "restart" });
    expect(restartedLine).not.toHaveBeenCalled();
    expect(after.run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf8")).every((n: { status: string }) => n.status === "failed")).toBe(true);
  }));

  it("ends a routine's work with its run on restart, even when it would otherwise be picked back up", () => fixture(async (engine, hooks, file) => {
    hooks.run = () => new Promise(() => {});
    const { node } = engine.enqueue(chief, "turn", undefined, builder, "build", "Build it", false, false, "", undefined, undefined, "routine-run");
    const later = engine.enqueue(chief, "turn", undefined, scout, "scout", "Find it", false, false, "", undefined, undefined, "other-run").node;
    engine.tick(); await flush();
    expect(engine.nodes.get("turn")?.routineRunId).toBe("routine-run");
    const owner = engine.enqueue(scout, "owner-turn", undefined, builder, "owner", "Check it").node;
    const restartedLine = vi.fn();
    const after: RoomHandoffHooks = { ...hooks, busy: () => false, longWork: () => true, restarted: restartedLine, report: vi.fn(),
      run: vi.fn(async (n) => ({ ok: true, text: `${n.key} done` })) };
    const restarted = new RoomHandoffs(file, after);
    await settle(restarted, 8);
    for (const id of [node.id, later.id, "turn"]) expect(restarted.nodes.get(id)).toMatchObject({ status: "failed", endedBy: "restart" });
    expect(restarted.nodes.get(owner.id)?.status).toBe("completed");
    expect(after.run).not.toHaveBeenCalledWith(expect.objectContaining({ rootId: "turn" }), expect.anything(), expect.anything());
    expect(restartedLine).toHaveBeenCalledTimes(1);
    expect(restartedLine).toHaveBeenCalledWith(expect.objectContaining({ id: "owner-turn" }), expect.anything(), true);
  }));
});
