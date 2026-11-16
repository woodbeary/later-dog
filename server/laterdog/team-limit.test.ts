import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, ROOM_HANDOFF_LIMITS, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { teammateEndLabel } from "./handoff-budget.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const chief = { botId: "chief", threadId: "chief-chat" };
const helper = (name: string) => ({ botId: name, threadId: `${name}-chat` });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function team(limits: Partial<typeof ROOM_HANDOFF_LIMITS>, test: (engine: RoomHandoffs, hooks: RoomHandoffHooks, finish: (botId: string) => void, file: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "team-limit-"));
  const open = new Map<string, (result: HandoffRunResult) => void>();
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: vi.fn(), changed: () => {},
    run: vi.fn((node) => node.parentId
      ? new Promise<HandoffRunResult>(resolve => open.set(node.botId, resolve))
      : Promise.resolve({ ok: true, text: "chief wrapped up" })),
  };
  const finish = (botId: string) => { open.get(botId)?.({ ok: true, text: `${botId} done` }); open.delete(botId); };
  try { const file = join(dir, "requests.json"); await test(new RoomHandoffs(file, hooks, Date.now, limits), hooks, finish, file); }
  finally { await removeTempDir(dir); }
}

describe("a team task's limits", () => {
  it("never charges the coordinator's wakes to the run budget", () => team({ executions: 2 }, async (engine, hooks, finish) => {
    engine.enqueue(chief, "turn", undefined, helper("scout"), "a", "Look into A");
    engine.enqueue(chief, "turn", undefined, helper("tally"), "b", "Look into B");
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    finish("scout"); await flush(); engine.tick(); await flush();
    finish("tally"); await flush(); engine.tick(); await flush(); engine.tick(); await flush();
    expect(engine.nodes.get("turn")?.status).toBe("completed");
    expect(engine.nodes.get("turn")?.executions).toBe(2);
    expect(hooks.run).toHaveBeenCalledWith(engine.nodes.get("turn"), true, expect.anything());
  }));

  it("refuses only new work at the cap, keeps running helpers going, and wakes the coordinator with every result", () => team({ executions: 1 }, async (engine, hooks, finish) => {
    const scout = engine.enqueue(chief, "turn", undefined, helper("scout"), "a", "Look into A").node;
    const tally = engine.enqueue(chief, "turn", undefined, helper("tally"), "b", "Look into B").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush(); engine.tick(); await flush();
    expect(scout.status).toBe("running");
    expect(tally).toMatchObject({ status: "failed", endedBy: "team-limit" });
    expect(tally.result).toMatch(/team reached its limit of 1 teammate run/);
    expect(() => engine.enqueue(chief, "turn", undefined, helper("relay"), "c", "Look into C")).toThrow(/reached its limit of 1 teammate run.*no new teammate work can start/);
    finish("scout"); await flush(); engine.tick(); await flush(); engine.tick(); await flush();
    expect(scout.status).toBe("completed");
    expect(hooks.run).toHaveBeenLastCalledWith(engine.nodes.get("turn"), true, expect.anything());
    expect(engine.nodes.get("turn")?.status).toBe("completed");
    expect(teammateEndLabel("Tally", "failed", "team-limit")).toBe("Tally not started: the team reached its limit");
  }));

  it("does not charge a re-run after a restart", () => team({ executions: 1 }, async (engine, hooks, _finish, file) => {
    const scout = engine.enqueue(chief, "turn", undefined, helper("scout"), "a", "Look into A").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    expect(scout.status).toBe("running");
    const restarted = new RoomHandoffs(file, { ...hooks, longWork: () => true });
    restarted.tick(); await flush();
    expect(restarted.nodes.get(scout.id)?.status).toBe("running");
    expect(restarted.nodes.get("turn")?.executions).toBe(1);
  }));

  it("charges every re-run after the first when a helper's run never finishes across restarts", () => team({ executions: 5 }, async (engine, hooks, _finish, file) => {
    const crasher = engine.enqueue(chief, "turn", undefined, helper("crasher"), "a", "Do the heavy thing").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    let home = engine;
    for (let restart = 0; restart < 20; restart++) {
      home = new RoomHandoffs(file, { ...hooks, longWork: () => true }, Date.now, { executions: 5 });
      home.tick(); await flush();
    }
    const runs = vi.mocked(hooks.run).mock.calls.filter(([node]) => node.id === crasher.id).length;
    expect(runs).toBe(6);
    expect(home.nodes.get(crasher.id)).toMatchObject({ status: "failed", endedBy: "team-limit" });
    expect(home.nodes.get("turn")?.executions).toBe(5);
  }));

  it("still stops a coordinator that keeps handing out work", () => team({ requests: 3 }, async (engine, _hooks, finish) => {
    for (const name of ["one", "two", "three"]) {
      engine.enqueue(chief, "turn", undefined, helper(name), name, `Again ${name}`);
      engine.tick(); await flush(); finish(name); await flush(); engine.tick(); await flush();
    }
    expect(() => engine.enqueue(chief, "turn", undefined, helper("four"), "four", "Again four"))
      .toThrow(/already sent 3 requests.*no new teammate work can start/);
  }));
});
