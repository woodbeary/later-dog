import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dogRoutines } from "../../deploy/laterdog/home/src/dog-routines.ts";
import type { RoutinesAnswer, RoutinesRequest } from "../../shared/dog-object-protocol.ts";
import { RoutineManager } from "../routines.ts";
import { ObjectRoutines } from "./object-routines.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-11-27T18:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sql(database: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-object-routines-"));
  dirs.push(dir);
  const clock = { now: START };
  const database = new DatabaseSync(":memory:");
  const alarm = { at: null as number | null, async set(at: number) { alarm.at = at; }, async clear() { alarm.at = null; } };
  const object = dogRoutines(sql(database), alarm, () => clock.now);
  const link = { down: false };
  const calls = {
    async routines(_dog: string, body: RoutinesRequest): Promise<RoutinesAnswer> {
      if (link.down) throw new Error("coordinator unreachable");
      if (body.op === "put") return object.putRoutines(body.timeZone, body.routines);
      if (body.op === "claim") return object.claimRoutines();
      if (body.op === "export") return object.exportRoutines();
      const settled = await object.settleRoutine(body.id, body.state, body.runId);
      if (!settled) throw Object.assign(new Error("occurrence_unknown"), { status: 409 });
      return settled;
    },
  };
  const owned = { object: true };
  const started: string[] = [];
  const home = (file: string) => {
    let bridge: ObjectRoutines | null = null;
    let task = 0;
    const manager = new RoutineManager({
      file,
      now: () => clock.now,
      botState: () => "ready",
      conversationFor: () => `thread-${++task}`,
      startTurn: async (_botId, _threadId, _prompt, _runOn, _trigger, _onError, runId) => { started.push(runId); },
      objectOwned: () => owned.object,
      beforeStart: (run) => bridge!.beforeStart(run),
      onRunChanged: (run) => bridge?.runChanged(run),
      emit: (payload) => { if (payload.kind === "routine") bridge?.changed("dog-1"); },
    });
    bridge = new ObjectRoutines({ calls, book: () => manager, owned: () => owned.object, dogs: () => ["dog-1"], timeZone: () => "UTC", now: () => clock.now, log: () => {} });
    for (const dog of ["dog-1"]) bridge.changed(dog);
    const step = async () => { await bridge!.poll(); await manager.tick(); await bridge!.poll(); };
    return { manager, bridge, step };
  };
  const file = join(dir, "routines.json");
  const finish = (manager: RoutineManager, threadId: string) => manager.handleRuntimeEvent({
    eventId: `done-${threadId}`, provider: "fake", threadId, createdAt: new Date(clock.now).toISOString(), type: "turn.completed", ok: true,
  });
  return { clock, alarm, object, link, owned, started, home, file, dir, finish };
}

const every10 = (anchorAt: number) => ({ name: "Check", prompt: "Check the fixture", botId: "dog-1", schedule: { type: "interval" as const, everyMinutes: 10, anchorAt } });

describe("routines fired by the dog object", () => {
  it("starts each occurrence once, on time, and leaves the home's own scheduler idle", async () => {
    const w = world();
    const first = w.home(w.file);
    const routine = first.manager.create(every10(START + 10 * MINUTE));
    await first.step();
    expect(w.alarm.at).toBe(START + 10 * MINUTE);
    w.clock.now = START + 10 * MINUTE + 2_000;
    await first.step();
    await first.step();
    expect(w.started).toEqual([`${routine.id}-at-${START + 10 * MINUTE}`]);
    w.finish(first.manager, "thread-1");
    await first.step();
    expect((await w.object.claimRoutines()).occurrences).toEqual([]);
    expect(w.alarm.at).toBe(START + 20 * MINUTE);
  });

  it("fires while the home is down and starts the run once after a restart that lost the last save", async () => {
    const w = world();
    const before = w.home(w.file);
    const routine = before.manager.create(every10(START + 10 * MINUTE));
    await before.step();
    const stale = join(w.dir, "stale.json");
    copyFileSync(w.file, stale);
    w.clock.now = START + 10 * MINUTE;
    expect(await w.object.fireRoutines()).toBe(1);
    w.clock.now = START + 11 * MINUTE;
    const after = w.home(stale);
    await after.step();
    await after.step();
    expect(w.started).toEqual([`${routine.id}-at-${START + 10 * MINUTE}`]);
    expect(after.manager.listRoutines()[0]!.nextRunAt).toBe(START + 20 * MINUTE);
  });

  it("does not start a run again when the home restarts after telling the object it started", async () => {
    const w = world();
    const before = w.home(w.file);
    const routine = before.manager.create(every10(START + 10 * MINUTE));
    await before.step();
    const stale = join(w.dir, "stale.json");
    copyFileSync(w.file, stale);
    w.clock.now = START + 10 * MINUTE;
    await before.step();
    expect(w.started).toHaveLength(1);
    const after = w.home(stale);
    await after.step();
    await after.step();
    expect(w.started).toHaveLength(1);
    const run = after.manager.findRun(`${routine.id}-at-${START + 10 * MINUTE}`);
    expect(run?.status).toBe("failed");
    expect((await w.object.claimRoutines()).occurrences).toEqual([]);
  });

  it("holds a due run while the coordinator is unreachable and starts it when it answers", async () => {
    const w = world();
    const home = w.home(w.file);
    home.manager.create(every10(START + 10 * MINUTE));
    await home.step();
    w.clock.now = START + 10 * MINUTE;
    await w.object.fireRoutines();
    w.link.down = true;
    await home.step();
    expect(w.started).toEqual([]);
    w.link.down = false;
    w.clock.now += 10_000;
    home.bridge.changed("dog-1");
    await home.step();
    expect(w.started).toHaveLength(1);
  });

  it("hands its schedule back so the home's scheduler resumes where the object was", async () => {
    const w = world();
    const home = w.home(w.file);
    const routine = home.manager.create(every10(START + 10 * MINUTE));
    await home.step();
    w.clock.now = START + 10 * MINUTE;
    await home.step();
    w.finish(home.manager, "thread-1");
    await home.step();
    await home.bridge.handBack("dog-1");
    w.owned.object = false;
    expect(home.manager.listRoutines()[0]!.nextRunAt).toBe(START + 20 * MINUTE);
    w.clock.now = START + 20 * MINUTE;
    await home.manager.tick();
    expect(w.started).toHaveLength(2);
    expect(w.started[1]).not.toBe(`${routine.id}-at-${START + 20 * MINUTE}`);
    expect(w.alarm.at).toBeNull();
  });
});
