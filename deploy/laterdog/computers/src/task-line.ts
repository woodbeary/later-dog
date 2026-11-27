import { DurableObject } from "cloudflare:workers";
import type { Size } from "./inputs";
import {
  type Machine,
  type MachineSize,
  type Settlement,
  type TaskLineSettings,
  type Ticket,
  type TicketClass,
  type TicketRequest,
  type TicketState,
  LEASE_MS,
  clampSettings,
  defaultSettings,
  machineIdFor,
  machinesMax,
  nextCheckAt,
  placeOf,
  queuedInOrder,
  settle,
} from "./task-line-policy";

const ENDED_KEPT_MS = 24 * 60 * 60 * 1000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export interface TicketView {
  id: string;
  key: string;
  thread: string;
  dog?: string;
  size: MachineSize;
  class: TicketClass;
  state: TicketState;
  place?: number;
  ahead?: number;
  machine?: { id: string; size: MachineSize; computerSize: Size; reused: boolean };
  leaseUntil?: string;
  cap: number;
  running: number;
}

export interface MachineView {
  id: string;
  thread: string;
  dog?: string;
  size: MachineSize;
  computerSize: Size;
  startedAt: string;
  busy: boolean;
  idleSince?: string;
}

export interface LineView {
  settings: TaskLineSettings;
  max: number;
  running: MachineView[];
  waiting: TicketView[];
}

type TicketRow = {
  id: string;
  key: string;
  thread: string;
  dog: string | null;
  size: string;
  class: string;
  state: string;
  seq: number;
  created_at: number;
  polled_at: number;
  machine_id: string | null;
  admitted_at: number | null;
  lease_until: number | null;
  ended_at: number | null;
  reused: number;
};

type MachineRow = {
  id: string;
  thread: string;
  dog: string | null;
  size: string;
  started_at: number;
  idle_since: number | null;
  ticket_id: string | null;
};

type SettingsRow = { home: string | null; cap: number; idle_minutes: number; sizes: string };

function ticketFrom(row: TicketRow): Ticket {
  return {
    id: row.id,
    key: row.key,
    thread: row.thread,
    ...(row.dog === null ? {} : { dog: row.dog }),
    size: row.size as MachineSize,
    class: row.class as TicketClass,
    state: row.state as TicketState,
    seq: row.seq,
    createdAt: row.created_at,
    polledAt: row.polled_at,
    ...(row.machine_id === null ? {} : { machineId: row.machine_id }),
    ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}

function machineFrom(row: MachineRow): Machine {
  return {
    id: row.id,
    thread: row.thread,
    ...(row.dog === null ? {} : { dog: row.dog }),
    size: row.size as MachineSize,
    startedAt: row.started_at,
    ...(row.idle_since === null ? {} : { idleSince: row.idle_since }),
    ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id }),
  };
}

function newTicketId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) id += BASE32[byte & 31];
  return `tkt_${id}`;
}

const iso = (at: number) => new Date(at).toISOString();

export class TaskLine extends DurableObject<Env> {
  private readonly waiters = new Set<() => void>();
  private readonly max = machinesMax(this.env);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      home TEXT,
      cap INTEGER NOT NULL,
      idle_minutes INTEGER NOT NULL,
      sizes TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      thread TEXT NOT NULL,
      dog TEXT,
      size TEXT NOT NULL,
      class TEXT NOT NULL,
      state TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      polled_at INTEGER NOT NULL,
      machine_id TEXT,
      admitted_at INTEGER,
      lease_until INTEGER,
      ended_at INTEGER,
      reused INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      thread TEXT NOT NULL,
      dog TEXT,
      size TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      idle_since INTEGER,
      ticket_id TEXT
    )`);
  }

  private settings(): TaskLineSettings {
    const row = this.ctx.storage.sql.exec<SettingsRow>("SELECT home, cap, idle_minutes, sizes FROM settings WHERE id = 1").toArray()[0];
    if (!row) return defaultSettings(this.max);
    return clampSettings({ cap: row.cap, idleMinutes: row.idle_minutes, sizes: { ...defaultSettings(this.max).sizes, ...JSON.parse(row.sizes) } }, this.max);
  }

  private home(home: string): void {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ home: string | null }>("SELECT home FROM settings WHERE id = 1").toArray()[0];
    if (row?.home === home) return;
    if (row) sql.exec("UPDATE settings SET home = ? WHERE id = 1", home);
    else {
      const initial = defaultSettings(this.max);
      sql.exec("INSERT INTO settings (id, home, cap, idle_minutes, sizes) VALUES (1, ?, ?, ?, ?)", home, initial.cap, initial.idleMinutes, JSON.stringify(initial.sizes));
    }
  }

  private homeName(): string {
    return this.ctx.storage.sql.exec<{ home: string | null }>("SELECT home FROM settings WHERE id = 1").toArray()[0]?.home ?? "";
  }

  private tickets(): Ticket[] {
    return this.ctx.storage.sql.exec<TicketRow>("SELECT * FROM tickets WHERE state IN ('queued', 'admitted') ORDER BY seq").toArray().map(ticketFrom);
  }

  private machines(): Machine[] {
    return this.ctx.storage.sql.exec<MachineRow>("SELECT * FROM machines ORDER BY started_at, id").toArray().map(machineFrom);
  }

  private ticketRow(where: "id" | "key", value: string): TicketRow | undefined {
    return this.ctx.storage.sql.exec<TicketRow>(`SELECT * FROM tickets WHERE ${where} = ?`, value).toArray()[0];
  }

  private view(row: TicketRow): TicketView {
    const ticket = ticketFrom(row);
    const settings = this.settings();
    const running = this.machines();
    const place = placeOf(ticket, this.tickets());
    const machine = ticket.machineId && ticket.state === "admitted" ? running.find((candidate) => candidate.id === ticket.machineId) : undefined;
    return {
      id: ticket.id,
      key: ticket.key,
      thread: ticket.thread,
      ...(ticket.dog === undefined ? {} : { dog: ticket.dog }),
      size: ticket.size,
      class: ticket.class,
      state: ticket.state,
      ...(place === undefined ? {} : { place, ahead: place - 1 }),
      ...(machine ? { machine: { id: machine.id, size: machine.size, computerSize: settings.sizes[machine.size], reused: row.reused === 1 } } : {}),
      ...(ticket.state === "admitted" && ticket.leaseUntil !== undefined ? { leaseUntil: iso(ticket.leaseUntil) } : {}),
      cap: settings.cap,
      running: running.length,
    };
  }

  private async reconcile(): Promise<Settlement> {
    const now = Date.now();
    const settings = this.settings();
    const tickets = this.tickets();
    const home = this.homeName();
    const names = new Map<string, string>();
    for (const ticket of queuedInOrder(tickets)) names.set(ticket.id, await machineIdFor(home, ticket));
    const fresh = { now: Date.now(), settings: this.settings(), tickets: this.tickets(), machines: this.machines() };
    const result = settle(fresh, (ticket) => names.get(ticket.id)!);
    this.apply(result, fresh.now);
    for (const machine of result.newMachines) await this.startMachine(machine, settings, home);
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE state NOT IN ('queued', 'admitted') AND ended_at < ?", now - ENDED_KEPT_MS);
    for (const id of result.stop) void this.stopMachine(id);
    const next = nextCheckAt({ now: fresh.now, settings, tickets: this.tickets(), machines: this.machines() });
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    }
    this.notify();
    return result;
  }

  private apply(result: Settlement, now: number): void {
    const sql = this.ctx.storage.sql;
    for (const id of result.expire) sql.exec("UPDATE tickets SET state = 'expired', ended_at = ? WHERE id = ? AND state = 'queued'", now, id);
    for (const id of result.release) sql.exec("UPDATE tickets SET state = 'expired', ended_at = ? WHERE id = ? AND state = 'admitted'", now, id);
    for (const { machineId, since } of result.idle) sql.exec("UPDATE machines SET ticket_id = NULL, idle_since = ? WHERE id = ?", since, machineId);
    for (const id of result.stop) {
      sql.exec("DELETE FROM machines WHERE id = ?", id);
      console.log(`laterdog computers: [task-line] stop ${id}`);
    }
    for (const machine of result.newMachines) {
      sql.exec(
        "INSERT INTO machines (id, thread, dog, size, started_at, idle_since, ticket_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
        machine.id, machine.thread, machine.dog ?? null, machine.size, machine.startedAt,
      );
    }
    for (const admission of result.admit) {
      sql.exec("UPDATE machines SET ticket_id = ?, idle_since = NULL WHERE id = ?", admission.ticketId, admission.machineId);
      sql.exec(
        "UPDATE tickets SET state = 'admitted', machine_id = ?, admitted_at = ?, lease_until = ?, reused = ? WHERE id = ?",
        admission.machineId, now, now + LEASE_MS, admission.reuse ? 1 : 0, admission.ticketId,
      );
      console.log(`laterdog computers: [task-line] admit ${admission.ticketId} on ${admission.machineId}${admission.reuse ? " (reused)" : ""}`);
    }
  }

  private async startMachine(machine: Machine, settings: TaskLineSettings, home: string): Promise<void> {
    try {
      const started = await this.env.COMPUTER.get(this.env.COMPUTER.idFromName(machine.id)).initTask({
        id: machine.id,
        name: `task ${machine.thread}`.slice(0, 80),
        size: settings.sizes[machine.size],
        line: home,
        idleMinutes: settings.idleMinutes,
      });
      if (!started.ok) console.error(`laterdog computers: [task-line] start ${machine.id} refused: ${started.refusal.message}`);
      else console.log(`laterdog computers: [task-line] start ${machine.id} (${machine.size}, ${settings.sizes[machine.size]})`);
    } catch (error) {
      console.error(`laterdog computers: [task-line] start ${machine.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async stopMachine(id: string): Promise<void> {
    try {
      const retired = await this.env.COMPUTER.get(this.env.COMPUTER.idFromName(id)).retire("line");
      if (!retired.ok && retired.refusal.code === "not_a_task_machine") await this.env.COMPUTER.get(this.env.COMPUTER.idFromName(id)).remove();
    } catch (error) {
      console.error(`laterdog computers: [task-line] stop ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private notify(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  async line(home: string): Promise<LineView> {
    this.home(home);
    await this.reconcile();
    const settings = this.settings();
    const waiting = queuedInOrder(this.tickets()).map((ticket) => this.view(this.ticketRow("id", ticket.id)!));
    const running = this.machines().map((machine) => ({
      id: machine.id,
      thread: machine.thread,
      ...(machine.dog === undefined ? {} : { dog: machine.dog }),
      size: machine.size,
      computerSize: settings.sizes[machine.size],
      startedAt: iso(machine.startedAt),
      busy: machine.ticketId !== undefined,
      ...(machine.idleSince === undefined ? {} : { idleSince: iso(machine.idleSince) }),
    }));
    return { settings, max: this.max, running, waiting };
  }

  async configure(home: string, settings: TaskLineSettings): Promise<LineView> {
    this.home(home);
    const next = clampSettings(settings, this.max);
    this.ctx.storage.sql.exec("UPDATE settings SET cap = ?, idle_minutes = ?, sizes = ? WHERE id = 1", next.cap, next.idleMinutes, JSON.stringify(next.sizes));
    console.log(`laterdog computers: [task-line] settings cap ${next.cap} idle ${next.idleMinutes} min`);
    return this.line(home);
  }

  async currentSettings(home: string): Promise<TaskLineSettings> {
    this.home(home);
    return this.settings();
  }

  async take(home: string, request: TicketRequest): Promise<{ ticket: TicketView; replayed: boolean }> {
    this.home(home);
    const prior = this.ticketRow("key", request.key);
    if (prior) {
      if (prior.state === "queued") this.ctx.storage.sql.exec("UPDATE tickets SET polled_at = ? WHERE id = ?", Date.now(), prior.id);
      return { ticket: this.view(this.ticketRow("id", prior.id)!), replayed: true };
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const seq = sql.exec<{ next: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tickets").one().next;
    const id = newTicketId();
    sql.exec(
      "INSERT INTO tickets (id, key, thread, dog, size, class, state, seq, created_at, polled_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
      id, request.key, request.thread, request.dog ?? null, request.size, request.class, seq, now, now,
    );
    await this.reconcile();
    return { ticket: this.view(this.ticketRow("id", id)!), replayed: false };
  }

  async ticket(id: string, waitSeconds = 0): Promise<TicketView | undefined> {
    const row = this.touch(id);
    if (!row) return undefined;
    const before = this.view(row);
    if (waitSeconds <= 0 || before.state !== "queued") return before;
    const deadline = Date.now() + waitSeconds * 1000;
    let budget = waitSeconds * 1000;
    while (budget > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, budget);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.add(done);
      });
      const now = this.touch(id);
      if (!now) return undefined;
      const after = this.view(now);
      if (after.state !== before.state || after.place !== before.place) return after;
      budget = Math.min(budget - 1, deadline - Date.now());
    }
    return this.view(this.touch(id)!);
  }

  private touch(id: string): TicketRow | undefined {
    const row = this.ticketRow("id", id);
    if (!row) return undefined;
    const now = Date.now();
    if (row.state === "queued") this.ctx.storage.sql.exec("UPDATE tickets SET polled_at = ? WHERE id = ?", now, id);
    if (row.state === "admitted") this.ctx.storage.sql.exec("UPDATE tickets SET lease_until = ? WHERE id = ?", now + LEASE_MS, id);
    return this.ticketRow("id", id);
  }

  async drop(id: string): Promise<TicketView | undefined> {
    const row = this.ticketRow("id", id);
    if (!row) return undefined;
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (row.state === "queued") sql.exec("UPDATE tickets SET state = 'cancelled', ended_at = ? WHERE id = ?", now, id);
    if (row.state === "admitted") {
      sql.exec("UPDATE tickets SET state = 'released', ended_at = ? WHERE id = ?", now, id);
      sql.exec("UPDATE machines SET ticket_id = NULL, idle_since = ? WHERE id = ? AND ticket_id = ?", now, row.machine_id, id);
    }
    await this.reconcile();
    return this.view(this.ticketRow("id", id)!);
  }

  async machineGone(id: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<MachineRow>("SELECT * FROM machines WHERE id = ?", id).toArray()[0];
    if (!row) return false;
    sql.exec("DELETE FROM machines WHERE id = ?", id);
    if (row.ticket_id !== null) sql.exec("UPDATE tickets SET state = 'expired', ended_at = ? WHERE id = ? AND state = 'admitted'", Date.now(), row.ticket_id);
    console.log(`laterdog computers: [task-line] gone ${id}`);
    await this.reconcile();
    return true;
  }

  override async alarm(): Promise<void> {
    await this.reconcile();
  }
}
