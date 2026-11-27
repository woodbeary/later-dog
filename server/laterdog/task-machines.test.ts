import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineOpener } from "./engine-placement.ts";
import type { EngineLink } from "./engine-remote.ts";
import { saveTaskMachineSetting, taskMachineOpener, taskMachineSetting, turnEnded, type TaskLineService, type TicketView } from "./task-machines.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function dataDir(enabled = true, bots?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "task-machines-"));
  scratch.push(dir);
  saveTaskMachineSetting(dir, { enabled, ...(bots ? { bots } : {}) });
  return dir;
}

function link(): EngineLink {
  const emitter = new EventEmitter() as EngineLink;
  emitter.send = () => undefined;
  emitter.close = () => { emitter.emit("close", "closed"); };
  return emitter;
}

function fakeLine(cap: number) {
  type Row = { id: string; thread: string; state: TicketView["state"]; machine?: string };
  const rows: Row[] = [];
  const waiters = new Set<() => void>();
  const dropped: string[] = [];
  const running = () => rows.filter((row) => row.state === "admitted").length;
  const settle = () => {
    for (const row of rows) if (row.state === "queued" && running() < cap) { row.state = "admitted"; row.machine = `cmp_${row.thread}`; }
    for (const wake of [...waiters]) wake();
  };
  const view = (row: Row): TicketView => {
    const queued = rows.filter((other) => other.state === "queued");
    const place = row.state === "queued" ? queued.indexOf(row) + 1 : undefined;
    return { id: row.id, state: row.state, ...(place ? { place, ahead: place - 1 } : {}), ...(row.machine && row.state === "admitted" ? { machine: { id: row.machine, size: "small", computerSize: "small", reused: false } } : {}), cap, running: running() };
  };
  const service: TaskLineService = {
    async take(input) {
      const row: Row = { id: `tkt_${rows.length + 1}`, thread: input.thread, state: "queued" };
      rows.push(row);
      settle();
      return view(row);
    },
    async ticket(id, waitSeconds, signal) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      if (waitSeconds > 0 && row.state === "queued") {
        await new Promise<void>((resolve) => {
          const done = () => { waiters.delete(done); resolve(); };
          waiters.add(done);
          setTimeout(done, 20);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
      return view(row);
    },
    async drop(id) {
      const row = rows.find((candidate) => candidate.id === id);
      dropped.push(id);
      if (row) row.state = row.state === "queued" ? "cancelled" : "released";
      settle();
    },
    async line() { return { running: running() }; },
    async configure() { return {}; },
  };
  return { service, rows, dropped, running };
}

function inner(): EngineOpener & { opened: string[] } {
  const opened: string[] = [];
  return { opened, proxyPath: "/proxy", openBudgetMs: 1000, async open(_botId, plan) { opened.push(plan.threadId); return link(); } };
}

const plan = (threadId: string) => ({ threadId }) as Parameters<EngineOpener["open"]>[1];
const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
const placements = (dir: string) => { try { return readFileSync(join(dir, "engine-placement.log"), "utf8"); } catch { return ""; } };

describe("task machine opener", () => {
  it("runs three of five task turns on their own machines at cap 3, tells the other two their places, and admits the next when a turn ends", async () => {
    const dir = dataDir();
    const line = fakeLine(3);
    const machines: string[] = [];
    const opener = taskMachineOpener(inner(), {
      dataDir: dir, ticketClass: () => "task", size: () => "small", service: () => line.service,
      openOn: async (machineId) => { machines.push(machineId); return link(); },
    });
    const opens = ["t1", "t2", "t3", "t4", "t5"].map((thread) => opener.open("dog-1", plan(thread)));
    await settled();
    expect(machines).toEqual(["cmp_t1", "cmp_t2", "cmp_t3"]);
    expect(line.rows.map((row) => row.state)).toEqual(["admitted", "admitted", "admitted", "queued", "queued"]);
    const log = placements(dir);
    expect(log).toContain("waiting for a small machine: place 1 (0 ahead), 3 of 3 running");
    expect(log).toContain("waiting for a small machine: place 2 (1 ahead), 3 of 3 running");
    const first = await opens[0]!;
    first.emit("line", JSON.stringify({ type: "stdout", data: Buffer.from('{"type":"result","subtype":"success"}\n').toString("base64") }));
    await settled();
    expect(line.dropped).toEqual(["tkt_1"]);
    expect(machines).toEqual(["cmp_t1", "cmp_t2", "cmp_t3", "cmp_t4"]);
    expect(placements(dir)).toContain("waiting for a machine: place 1 (0 ahead), 3 of 3 running");
  });

  it("leaves turns that are not tasks, dogs not chosen and a home with the setting off on the dog's computer", async () => {
    const line = fakeLine(3);
    for (const [dir, ticketClass] of [[dataDir(), () => null], [dataDir(true, ["other"]), () => "task" as const], [dataDir(false), () => "task" as const]] as const) {
      const computer = inner();
      const opener = taskMachineOpener(computer, { dataDir: dir, ticketClass, size: () => "small", service: () => line.service, openOn: async () => { throw new Error("not here"); } });
      await opener.open("dog-1", plan("t1"));
      expect(computer.opened).toEqual(["t1"]);
    }
    expect(line.rows).toEqual([]);
  });

  it("falls back to the dog's computer and returns the slot when the machine cannot open the engine", async () => {
    const dir = dataDir();
    const line = fakeLine(3);
    const computer = inner();
    const opener = taskMachineOpener(computer, { dataDir: dir, ticketClass: () => "task", size: () => "large", service: () => line.service, openOn: async () => { throw new Error("The task machine could not start."); } });
    await opener.open("dog-1", plan("t1"));
    expect(computer.opened).toEqual(["t1"]);
    expect(line.dropped).toEqual(["tkt_1"]);
    expect(placements(dir)).toContain("falls back to the dog's computer");
  });

  it("falls back after waiting in line past its budget, and cancels the ticket", async () => {
    const dir = dataDir();
    const line = fakeLine(0);
    const computer = inner();
    const opener = taskMachineOpener(computer, { dataDir: dir, ticketClass: () => "task", size: () => "small", service: () => line.service, queueBudgetMs: 1, openOn: async () => link() });
    await opener.open("dog-1", plan("t1"));
    expect(computer.opened).toEqual(["t1"]);
    expect(line.rows[0]!.state).toBe("cancelled");
  });

  it("cancels the ticket when the turn is stopped while it waits", async () => {
    const line = fakeLine(0);
    const opener = taskMachineOpener(inner(), { dataDir: dataDir(), ticketClass: () => "task", size: () => "small", service: () => line.service, openOn: async () => link() });
    const abort = new AbortController();
    const opening = opener.open("dog-1", plan("t1"), abort.signal);
    await settled();
    abort.abort();
    await expect(opening).rejects.toThrow();
    expect(line.rows[0]!.state).toBe("cancelled");
  });

  it("gives the queue its own time on top of the computer's open budget, and keeps the saved setting", () => {
    const dir = dataDir(true, ["dog-1"]);
    expect(taskMachineSetting(dir)).toEqual({ enabled: true, bots: ["dog-1"] });
    const opener = taskMachineOpener(inner(), { dataDir: dir, ticketClass: () => "task", size: () => "small", openOn: async () => link(), queueBudgetMs: 5000 });
    expect(opener.openBudgetMs).toBe(6000);
  });

  it("frees the slot when a turn's reply finishes, takes it back on the machine for the next turn, and frees it when the engine closes", async () => {
    const dir = dataDir();
    const line = fakeLine(1);
    const opener = taskMachineOpener(inner(), { dataDir: dir, ticketClass: () => "task", size: () => "small", service: () => line.service, openOn: async () => link() });
    const engine = await opener.open("dog-1", plan("t1"));
    expect(line.running()).toBe(1);
    engine.emit("line", JSON.stringify({ type: "native_exit", code: 0, signal: null }));
    await settled();
    expect(line.running()).toBe(0);
    engine.send(JSON.stringify({ type: "stdin", data: "next" }));
    await settled();
    expect(line.running()).toBe(1);
    expect(placements(dir)).toContain("next turn holds cmp_t1 again");
    engine.close();
    await settled();
    expect(line.running()).toBe(0);
  });

  it("sees a turn end even when the marker is split across two output frames", () => {
    const tail = { text: "" };
    const frame = (text: string) => JSON.stringify({ type: "stdout", data: Buffer.from(text).toString("base64") });
    expect(turnEnded(frame('{"type":"assistant"}\n{"ty'), tail)).toBe(false);
    expect(turnEnded(frame('pe":"result"}\n'), tail)).toBe(true);
    expect(turnEnded(frame('{"method":"turn/completed"}\n'), { text: "" })).toBe(true);
    expect(turnEnded(JSON.stringify({ type: "stderr", data: "eyJ0eXBlIjoicmVzdWx0In0=" }), { text: "" })).toBe(false);
  });
});
