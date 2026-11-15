import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { RESULT_MAX_WAIT_MS, RESULT_QUIET_MS, allResultsIn, resultsTurn, sessionHolds, splitResults } from "./handoff-results.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const lead = { botId: "lead", threadId: "lead-chat" };
const helper = (name: string) => ({ botId: name, threadId: `${name}-chat` });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Team {
  engine: RoomHandoffs;
  hooks: RoomHandoffHooks;
  file: string;
  clock: { at: number };
  finish(name: string, text?: string): void;
  wakes(): { fresh: string[]; earlier: string[]; out: string[] }[];
  told(): string[];
  settle(): Promise<void>;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

async function team(test: (t: Team) => Promise<void>) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "handoff-results-"));
  const clock = { at: 1_000_000 };
  const pending = new Map<string, (result: HandoffRunResult) => void>();
  const wakes: { fresh: string[]; earlier: string[]; out: string[] }[] = [];
  const told: string[] = [];
  let engine!: RoomHandoffs;
  const hooks: RoomHandoffHooks = {
    validate: () => undefined, busy: () => false, report: vi.fn(), changed: () => {},
    run: vi.fn(async (node: RoomHandoff, resumed: boolean) => {
      if (node.botId === lead.botId && resumed) {
        const split = splitResults(engine.awaited(node.id), node.startedAt);
        wakes.push({ fresh: split.fresh.map(n => n.botId), earlier: split.earlier.map(n => n.botId), out: split.out.map(n => n.botId) });
        told.push(resultsTurn(node.text, engine.awaited(node.id), node.startedAt,
          { asked: n => ({ bot: n.botId }), result: n => n.result, held: () => true }).text);
        return { ok: true, text: "acted on what came back" };
      }
      return new Promise<HandoffRunResult>(resolve => pending.set(node.botId, resolve));
    }),
  };
  const file = join(dir, "handoffs.json");
  engine = new RoomHandoffs(file, hooks, () => clock.at);
  const settle = async () => { for (let i = 0; i < 6; i++) { engine.tick(); await flush(); } };
  try {
    await test({
      engine, hooks, file, clock, settle, wakes: () => wakes, told: () => told,
      finish: (name, text = `${name} result`) => { pending.get(name)?.({ ok: true, text }); pending.delete(name); },
    });
  } finally { await removeTempDir(dir); }
}

function sendThree(engine: RoomHandoffs) {
  for (const name of ["pip", "quill", "rook"]) engine.enqueue(lead, "turn", undefined, helper(name), name, `Lane for ${name}`);
  engine.sourceSettled("turn", true);
}

describe("the one row and alert for a whole wait", () => {
  const done = { status: "completed", reported: true, givenAt: 1 };
  it("is due only when every helper is back", () => {
    expect(allResultsIn([done, { status: "running", reported: false }])).toBeUndefined();
    expect(allResultsIn([done, { ...done, status: "failed" }])).toHaveLength(2);
    expect(allResultsIn([])).toEqual([]);
  });
});

describe("whether the coordinator's current session still holds a result it was given", () => {
  const order = ["a", "row", "b", "c"];
  it("holds nothing when a new session starts or the result has no row", () => {
    expect(sessionHolds({ session: "s", ids: ["row"] }, undefined, order, "row")).toBe(false);
    expect(sessionHolds({ session: "s", ids: ["row"] }, "s", order, undefined)).toBe(false);
  });
  it("trusts a resumed session that keeps no record", () => {
    expect(sessionHolds(undefined, "s", order, "row")).toBe(true);
  });
  it("holds what its record says it received", () => {
    expect(sessionHolds({ session: "s", ids: ["row"] }, "s", order, "row")).toBe(true);
    expect(sessionHolds({ session: "s", through: "b", ids: [] }, "s", order, "row")).toBe(true);
    expect(sessionHolds({ session: "s", through: "a", ids: ["c"] }, "s", order, "row")).toBe(false);
  });
  it("does not hold a result a replacement session's rebuild left out, nor one from another session's record", () => {
    expect(sessionHolds({ session: "s", omitted: "row", through: "c", ids: [] }, "s", order, "row")).toBe(false);
    expect(sessionHolds({ session: "old", ids: ["row"] }, "s", order, "row")).toBe(false);
  });
});

describe("a coordinator is given its helpers' results as they come back", () => {
  it("wakes for the first results while a slow helper still works, then again for the slow one", () => team(async t => {
    sendThree(t.engine);
    await t.settle();
    t.finish("pip"); await t.settle();
    t.clock.at += 5_000;
    t.finish("quill"); await t.settle();
    expect(t.wakes()).toEqual([]);
    t.clock.at += RESULT_QUIET_MS;
    await t.settle();
    expect(t.wakes()).toEqual([{ fresh: ["pip", "quill"], earlier: [], out: ["rook"] }]);
    expect(t.engine.nodes.get("turn")?.status).toBe("waiting");
    t.clock.at += 10 * RESULT_MAX_WAIT_MS;
    await t.settle();
    expect(t.wakes()).toHaveLength(1);
    t.finish("rook"); await t.settle();
    expect(t.wakes()).toEqual([
      { fresh: ["pip", "quill"], earlier: [], out: ["rook"] },
      { fresh: ["rook"], earlier: ["pip", "quill"], out: [] },
    ]);
    expect(t.engine.nodes.get("turn")?.status).toBe("completed");
  }));

  it("does not hold the first result back for longer than the longest wait while results keep trickling in", () => team(async t => {
    const names = ["a1", "a2", "a3", "a4", "a5"];
    for (const name of [...names, "rook"]) t.engine.enqueue(lead, "turn", undefined, helper(name), name, `Lane for ${name}`);
    t.engine.sourceSettled("turn", true);
    await t.settle();
    const gap = RESULT_QUIET_MS - 3_000;
    for (const name of names) {
      t.finish(name); await t.settle();
      if (name !== "a5") { t.clock.at += gap; await t.settle(); }
    }
    t.clock.at = 1_000_000 + RESULT_MAX_WAIT_MS - 1; await t.settle();
    expect(t.wakes()).toEqual([]);
    t.clock.at += 1; await t.settle();
    expect(t.wakes()).toEqual([{ fresh: names, earlier: [], out: ["rook"] }]);
  }));

  it("waits for the coordinator's own turn to end, and gives it what arrived meanwhile in one turn", () => team(async t => {
    let busy = true;
    t.hooks.busy = node => node.botId === lead.botId && busy;
    sendThree(t.engine);
    await t.settle();
    t.finish("pip"); await t.settle();
    t.clock.at += RESULT_QUIET_MS; await t.settle();
    t.finish("quill"); await t.settle();
    t.clock.at += RESULT_MAX_WAIT_MS; await t.settle();
    expect(t.wakes()).toEqual([]);
    busy = false;
    await t.settle();
    expect(t.wakes()).toEqual([{ fresh: ["pip", "quill"], earlier: [], out: ["rook"] }]);
  }));

  it("lets the coordinator answer a result by sending that helper more work, and that result comes back too", () => team(async t => {
    sendThree(t.engine);
    const run = t.hooks.run;
    t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) => {
      const first = node.botId === lead.botId && resumed && t.wakes().length === 0;
      const done = run(node, resumed, signal);
      if (first) t.engine.enqueue(lead, "unused", node.id, helper("pip"), "pip", "Fix the boundary case", false, true);
      return done;
    });
    await t.settle();
    t.finish("pip"); t.finish("quill"); await t.settle();
    t.clock.at += RESULT_QUIET_MS; await t.settle();
    expect(t.wakes()).toEqual([{ fresh: ["pip", "quill"], earlier: [], out: ["rook"] }]);
    expect(t.engine.awaited("turn").map(n => n.botId)).toEqual(["pip", "quill", "rook", "pip"]);
    t.finish("pip", "boundary fixed"); await t.settle();
    t.clock.at += RESULT_QUIET_MS; await t.settle();
    expect(t.wakes()[1]).toEqual({ fresh: ["pip"], earlier: ["pip", "quill"], out: ["rook"] });
    t.finish("rook"); await t.settle();
    expect(t.wakes()).toHaveLength(3);
    expect(t.engine.nodes.get("turn")?.status).toBe("completed");
  }));

  it("keeps the still-working helpers going when the coordinator's results turn fails", () => team(async t => {
    sendThree(t.engine);
    const run = t.hooks.run;
    t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) =>
      node.botId === lead.botId && resumed ? { ok: false, text: "engine error" } : run(node, resumed, signal));
    await t.settle();
    t.finish("pip"); t.finish("quill"); await t.settle();
    t.clock.at += RESULT_QUIET_MS; await t.settle();
    expect(t.engine.nodes.get("turn")?.status).toBe("waiting");
    expect(t.engine.awaited("turn").find(n => n.botId === "rook")?.status).toBe("running");
  }));

  it("puts each of six results into the coordinator's turns once when they finish twenty seconds apart", () => team(async t => {
    const names = ["h1", "h2", "h3", "h4", "h5", "h6"];
    for (const name of names) t.engine.enqueue(lead, "turn", undefined, helper(name), name, `Lane for ${name}\nwith detail`);
    t.engine.sourceSettled("turn", true);
    await t.settle();
    for (const name of names) { t.finish(name, `${name.toUpperCase()}_RESULT_TEXT`); await t.settle(); t.clock.at += 20_000; await t.settle(); }
    expect(t.wakes()).toHaveLength(6);
    const told = t.told().join("\n");
    expect(names.map(name => count(told, `${name.toUpperCase()}_RESULT_TEXT`))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(count(t.told()[5], "Lane for h1")).toBe(1);
    expect(count(t.told()[5], "with detail")).toBe(1);
    expect(t.engine.nodes.get("turn")?.status).toBe("completed");
  }));

  for (const failure of ["returns a failure", "throws"] as const) {
    it(`gives the results of a results turn that ${failure} again with the next ones, once, without waking for them alone`, () => team(async t => {
      sendThree(t.engine);
      const run = t.hooks.run;
      let failures = 0;
      t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) => {
        if (node.botId === lead.botId && resumed && failures++ === 0) {
          if (failure === "throws") throw new Error("engine error");
          return { ok: false, text: "engine error" };
        }
        return run(node, resumed, signal);
      });
      await t.settle();
      t.finish("pip", "PIP_RESULT_TEXT"); t.finish("quill", "QUILL_RESULT_TEXT"); await t.settle();
      t.clock.at += RESULT_QUIET_MS; await t.settle();
      expect(failures).toBe(1);
      t.clock.at += 10 * RESULT_MAX_WAIT_MS; await t.settle();
      expect(failures).toBe(1);
      expect(t.engine.nodes.get("turn")?.status).toBe("waiting");
      t.finish("rook", "ROOK_RESULT_TEXT"); await t.settle();
      expect(t.wakes()).toEqual([{ fresh: ["pip", "quill", "rook"], earlier: [], out: [] }]);
      const told = t.told().join("\n");
      expect(["PIP", "QUILL", "ROOK"].map(name => count(told, `${name}_RESULT_TEXT`))).toEqual([1, 1, 1]);
      expect(t.engine.nodes.get("turn")?.status).toBe("completed");
    }));
  }

  it("gives the same results again when a results turn times out and is tried once more", () => team(async t => {
    sendThree(t.engine);
    const run = t.hooks.run;
    let timeouts = 0;
    t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) => {
      if (node.botId === lead.botId && resumed && timeouts++ === 0) { t.clock.at += 1; return { ok: false, timedOut: true, text: "timed out" }; }
      return run(node, resumed, signal);
    });
    await t.settle();
    t.finish("pip"); t.finish("quill"); await t.settle();
    t.clock.at += RESULT_QUIET_MS; await t.settle();
    expect(t.wakes()).toEqual([{ fresh: ["pip", "quill"], earlier: [], out: ["rook"] }]);
  }));

  it("gives the results again after a restart cut the results turn short", () => team(async t => {
    sendThree(t.engine);
    const run = t.hooks.run;
    t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) =>
      node.botId === lead.botId && resumed ? new Promise<HandoffRunResult>(() => {}) : run(node, resumed, signal));
    await t.settle();
    t.finish("pip"); t.finish("quill"); await t.settle();
    t.clock.at += RESULT_QUIET_MS; await t.settle();
    expect(t.engine.nodes.get("turn")?.status).toBe("running");
    const wakes: string[][] = [];
    const reloaded = new RoomHandoffs(t.file, { ...t.hooks, longWork: () => true,
      run: vi.fn(async (node: RoomHandoff, resumed: boolean) => {
        if (node.botId === lead.botId && resumed) wakes.push(splitResults(reloaded.awaited(node.id), node.startedAt).fresh.map(n => n.botId));
        return new Promise<HandoffRunResult>(() => {});
      }) }, () => t.clock.at);
    t.clock.at += RESULT_QUIET_MS;
    for (let i = 0; i < 4; i++) { reloaded.tick(); await flush(); }
    expect(wakes).toEqual([["pip", "quill"]]);
  }));

  it("never wakes for results it did not ask for", () => team(async t => {
    t.engine.enqueue(lead, "turn", undefined, helper("pip"), "pip", "FYI: the release is live", false, false, "", undefined, undefined, undefined, undefined, false, "none");
    t.engine.enqueue(lead, "turn", undefined, helper("rook"), "rook", "Long lane");
    t.engine.sourceSettled("turn", true);
    await t.settle();
    t.finish("pip"); await t.settle();
    t.clock.at += 10 * RESULT_MAX_WAIT_MS; await t.settle();
    expect(t.wakes()).toEqual([]);
  }));

  it("keeps a group chat's coordinator waiting for every result, as before", () => team(async t => {
    const room = (botId: string) => ({ groupId: `${botId}-room`, threadId: `${botId}-room-chat`, botId });
    t.engine.enqueue(room("lead"), "turn", undefined, room("pip"), "pip", "Lane for pip");
    t.engine.enqueue(room("lead"), "turn", undefined, room("rook"), "rook", "Lane for rook");
    t.engine.sourceSettled("turn", true);
    await t.settle();
    t.finish("pip"); await t.settle();
    t.clock.at += 10 * RESULT_MAX_WAIT_MS; await t.settle();
    expect(vi.mocked(t.hooks.run).mock.calls.filter(([node, resumed]) => node.botId === "lead" && resumed)).toHaveLength(0);
  }));
});

describe("a coordinator's handoffs saved before results were given as they came back", () => {
  async function fromOldState(rework: boolean) {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "handoff-results-old-"));
    const t0 = 900_000;
    const base = { reported: true, executions: 0, approvalGranted: false, kind: "work", result: "" };
    const nodes: unknown[] = [{ ...base, ...lead, id: "turn", rootId: "turn", key: "root", text: "Split the work", createdAt: t0,
      status: "waiting", startedAt: rework ? t0 + 50_000 : t0 + 1, executions: rework ? 2 : 1 }];
    ["h1", "h2", "h3", "h4"].forEach((name, i) => nodes.push({ ...base, ...helper(name), id: name, rootId: "turn", parentId: "turn", key: name,
      text: `Lane ${name}`, createdAt: t0 + 2 + i, status: "completed", result: `${name.toUpperCase()}_RESULT_TEXT`, startedAt: t0 + 10 }));
    ["h5", "h6"].forEach((name, i) => nodes.push({ ...base, ...helper(name), id: name, rootId: "turn", parentId: "turn", key: name,
      text: `Lane ${name}`, createdAt: rework ? t0 + 60_000 + i : t0 + 10 + i, status: "running", reported: false, startedAt: t0 + 70_000 }));
    const file = join(dir, "old.json");
    writeFileSync(file, JSON.stringify(nodes));
    const wakes: string[][] = [];
    const engine: RoomHandoffs = new RoomHandoffs(file, {
      validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, longWork: () => true,
      run: async (node, resumed) => {
        if (node.botId === lead.botId && resumed) wakes.push(splitResults(engine.awaited(node.id), node.startedAt).fresh.map(n => n.botId));
        return new Promise<HandoffRunResult>(() => {});
      },
    }, () => 1_000_000);
    for (let i = 0; i < 6; i++) { engine.tick(); await flush(); }
    await removeTempDir(dir);
    return wakes;
  }

  it("does not wake a coordinator for results it had before it sent rework", async () => {
    expect(await fromOldState(true)).toEqual([]);
  });

  it("still gives results that were never delivered on the first tick", async () => {
    expect(await fromOldState(false)).toEqual([["h1", "h2", "h3", "h4"]]);
  });
});

describe("the row and alert for a whole wait are written once", () => {
  const claiming = (t: Team, claims: string[][], then: (node: RoomHandoff, resumed: boolean, signal: AbortSignal, run: RoomHandoffHooks["run"]) => Promise<HandoffRunResult>) => {
    const run = t.hooks.run;
    t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) => {
      if (node.botId !== lead.botId || !resumed) return run(node, resumed, signal);
      const row = t.engine.claimSettledRow(node);
      if (row) claims.push(row.map(n => n.botId));
      return then(node, resumed, signal, run);
    });
  };

  it("once when the last results turn times out and is tried again", () => team(async t => {
    const claims: string[][] = [];
    let timeouts = 0;
    claiming(t, claims, async (node, resumed, signal, run) => {
      if (timeouts++ === 0) { t.clock.at += 1; return { ok: false, timedOut: true, text: "timed out" }; }
      return run(node, resumed, signal);
    });
    sendThree(t.engine);
    await t.settle();
    t.finish("pip"); t.finish("quill"); t.finish("rook"); await t.settle();
    expect(timeouts).toBe(2);
    expect(claims).toEqual([["pip", "quill", "rook"]]);
    expect(t.engine.nodes.get("turn")?.status).toBe("completed");
  }));

  it("once when a restart cuts the last results turn short", () => team(async t => {
    const claims: string[][] = [];
    claiming(t, claims, () => new Promise<HandoffRunResult>(() => {}));
    sendThree(t.engine);
    await t.settle();
    t.finish("pip"); t.finish("quill"); t.finish("rook"); await t.settle();
    let rerun = 0;
    const reloaded: RoomHandoffs = new RoomHandoffs(t.file, { ...t.hooks, longWork: () => true,
      run: vi.fn(async (node: RoomHandoff) => {
        rerun++;
        const row = reloaded.claimSettledRow(node);
        if (row) claims.push(row.map(n => n.botId));
        return { ok: true, text: "acted" };
      }) }, () => t.clock.at + 1_000);
    for (let i = 0; i < 6; i++) { reloaded.tick(); await flush(); }
    expect(rerun).toBe(1);
    expect(claims).toEqual([["pip", "quill", "rook"]]);
  }));

  it("again when rework sent from the last results turn comes back", () => team(async t => {
    const claims: string[][] = [];
    claiming(t, claims, async (node, resumed, signal, run) => {
      const done = run(node, resumed, signal);
      if (claims.length === 1 && t.engine.awaited(node.id).length === 3) t.engine.enqueue(lead, "unused", node.id, helper("pip"), "pip", "Fix the boundary case", false, true);
      return done;
    });
    sendThree(t.engine);
    await t.settle();
    t.finish("pip"); t.finish("quill"); t.finish("rook"); await t.settle();
    expect(claims).toHaveLength(1);
    t.finish("pip", "boundary fixed"); await t.settle();
    expect(claims).toEqual([["pip", "quill", "rook"], ["pip", "quill", "rook", "pip"]]);
    expect(t.engine.nodes.get("turn")?.status).toBe("completed");
  }));
});

describe("a last results turn that fails", () => {
  for (const failure of ["returns a failure", "throws"] as const) {
    it(`is tried once more with the same results when it ${failure}`, () => team(async t => {
      const run = t.hooks.run;
      let failures = 0;
      t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) => {
        if (node.botId === lead.botId && resumed && failures++ === 0) {
          if (failure === "throws") throw new Error("engine error");
          return { ok: false, text: "engine error" };
        }
        return run(node, resumed, signal);
      });
      sendThree(t.engine);
      await t.settle();
      t.finish("pip"); t.finish("quill"); t.finish("rook"); await t.settle();
      expect(failures).toBe(2);
      expect(t.wakes()).toEqual([{ fresh: ["pip", "quill", "rook"], earlier: [], out: [] }]);
      expect(t.engine.nodes.get("turn")?.status).toBe("completed");
    }));
  }

  it("stops after the second failure and leaves its results marked as not delivered", () => team(async t => {
    let runs = 0;
    const run = t.hooks.run;
    t.hooks.run = vi.fn(async (node: RoomHandoff, resumed: boolean, signal: AbortSignal) => {
      if (node.botId === lead.botId && resumed) { runs++; return { ok: false, text: "engine error" }; }
      return run(node, resumed, signal);
    });
    sendThree(t.engine);
    await t.settle();
    t.finish("pip"); t.finish("quill"); t.finish("rook"); await t.settle();
    t.clock.at += 10 * RESULT_MAX_WAIT_MS; await t.settle();
    expect(runs).toBe(2);
    expect(t.engine.nodes.get("turn")?.status).toBe("failed");
    expect(t.engine.awaited("turn").map(n => n.givenAt)).toEqual([undefined, undefined, undefined]);
  }));
});
