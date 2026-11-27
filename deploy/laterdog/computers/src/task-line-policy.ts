import type { Refusal } from "./auth";
import { sha256Hex } from "./auth";
import { MINUTE, bounded } from "./idle";
import { SIZES, type Size } from "./inputs";

export const TICKET_CLASSES = ["person", "task", "routine"] as const;
export type TicketClass = (typeof TICKET_CLASSES)[number];
export const MACHINE_SIZES = ["small", "large"] as const;
export type MachineSize = (typeof MACHINE_SIZES)[number];

export const DEFAULT_CAP = 20;
export const DEFAULT_IDLE_MINUTES = 5;
export const MIN_IDLE_MINUTES = 2;
export const MAX_IDLE_MINUTES = 30;
export const DEFAULT_MACHINES_MAX = 100;
export const DEFAULT_SIZES: Readonly<Record<MachineSize, Size>> = { small: "small", large: "xlarge" };
export const UNPOLLED_DROP_MS = 60_000;
export const LEASE_MS = 2 * MINUTE;
export const RECONCILE_MS = 30_000;
export const MAX_WAIT_SECONDS = 25;
export const KEY_MAX_CHARS = 200;
export const THREAD_MAX_CHARS = 200;

export interface TaskLineSettings {
  cap: number;
  idleMinutes: number;
  sizes: Record<MachineSize, Size>;
}

export type TicketState = "queued" | "admitted" | "released" | "cancelled" | "expired";

export interface Ticket {
  id: string;
  key: string;
  thread: string;
  dog?: string;
  size: MachineSize;
  class: TicketClass;
  state: TicketState;
  seq: number;
  createdAt: number;
  polledAt: number;
  machineId?: string;
  admittedAt?: number;
  leaseUntil?: number;
  endedAt?: number;
}

export interface Machine {
  id: string;
  thread: string;
  dog?: string;
  size: MachineSize;
  startedAt: number;
  idleSince?: number;
  ticketId?: string;
}

export interface TicketRequest {
  key: string;
  thread: string;
  dog?: string;
  size: MachineSize;
  class: TicketClass;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const bad = (code: string, message: string): Parsed<never> => ({ ok: false, refusal: { status: 400, code, message } });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VISIBLE = /^[\x21-\x7e]+$/;

function text(raw: unknown, name: string, max: number): Parsed<string> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max || !VISIBLE.test(raw)) {
    return bad(`invalid_${name}`, `${name} must be 1 to ${max} visible ASCII characters.`);
  }
  return { ok: true, value: raw };
}

export function machinesMax(env: { TASK_MACHINES_MAX?: string }): number {
  return Math.floor(bounded(env.TASK_MACHINES_MAX, DEFAULT_MACHINES_MAX, 1, 10_000));
}

export function defaultSettings(max: number): TaskLineSettings {
  return { cap: Math.min(DEFAULT_CAP, max), idleMinutes: DEFAULT_IDLE_MINUTES, sizes: { ...DEFAULT_SIZES } };
}

export function parseSettings(body: unknown, current: TaskLineSettings, max: number): Parsed<TaskLineSettings> {
  if (!isObject(body)) return bad("invalid_body", 'The body must be a JSON object with "cap", "idleMinutes" or "sizes".');
  const next: TaskLineSettings = { ...current, sizes: { ...current.sizes } };
  if (body.cap !== undefined) {
    if (typeof body.cap !== "number" || !Number.isInteger(body.cap) || body.cap < 1 || body.cap > max) {
      return bad("invalid_cap", `cap must be a whole number from 1 to ${max}.`);
    }
    next.cap = body.cap;
  }
  if (body.idleMinutes !== undefined) {
    const minutes = body.idleMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_IDLE_MINUTES || minutes > MAX_IDLE_MINUTES) {
      return bad("invalid_idle_minutes", `idleMinutes must be a whole number from ${MIN_IDLE_MINUTES} to ${MAX_IDLE_MINUTES}.`);
    }
    next.idleMinutes = minutes;
  }
  if (body.sizes !== undefined) {
    if (!isObject(body.sizes)) return bad("invalid_sizes", 'sizes must be an object like { "small": "small", "large": "xlarge" }.');
    for (const [name, size] of Object.entries(body.sizes)) {
      if (!(MACHINE_SIZES as readonly string[]).includes(name)) return bad("invalid_sizes", `sizes may only name ${MACHINE_SIZES.join(" and ")}.`);
      if (typeof size !== "string" || !Object.hasOwn(SIZES, size)) return bad("invalid_sizes", `each size must be one of ${Object.keys(SIZES).join(", ")}.`);
      next.sizes[name as MachineSize] = size as Size;
    }
  }
  return { ok: true, value: next };
}

export function clampSettings(settings: TaskLineSettings, max: number): TaskLineSettings {
  return { ...settings, cap: Math.max(1, Math.min(settings.cap, max)) };
}

export function parseTicketRequest(body: unknown): Parsed<TicketRequest> {
  if (!isObject(body)) return bad("invalid_body", 'The body must be a JSON object with "key", "thread", "size" and "class".');
  const key = text(body.key, "key", KEY_MAX_CHARS);
  if (!key.ok) return key;
  const thread = text(body.thread, "thread", THREAD_MAX_CHARS);
  if (!thread.ok) return thread;
  let dog: string | undefined;
  if (body.dog !== undefined && body.dog !== null) {
    const parsed = text(body.dog, "dog", THREAD_MAX_CHARS);
    if (!parsed.ok) return parsed;
    dog = parsed.value;
  }
  const size = body.size ?? "small";
  if (typeof size !== "string" || !(MACHINE_SIZES as readonly string[]).includes(size)) return bad("invalid_size", `size must be ${MACHINE_SIZES.join(" or ")}.`);
  const klass = body.class ?? "task";
  if (typeof klass !== "string" || !(TICKET_CLASSES as readonly string[]).includes(klass)) return bad("invalid_class", `class must be one of ${TICKET_CLASSES.join(", ")}.`);
  return { ok: true, value: { key: key.value, thread: thread.value, ...(dog === undefined ? {} : { dog }), size: size as MachineSize, class: klass as TicketClass } };
}

export function parseWaitSeconds(raw: string | null): number {
  if (raw === null) return 0;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_WAIT_SECONDS, seconds);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export async function machineIdFor(home: string, ticket: { thread: string; dog?: string; size: MachineSize }): Promise<string> {
  const digest = await sha256Hex(`task\u0000${home}\u0000${ticket.dog ?? ""}\u0000${ticket.thread}\u0000${ticket.size}`);
  let id = "";
  for (let i = 0; i < 12; i++) id += BASE32[Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16) & 31];
  return `cmp_${id}`;
}

const RANK: Record<TicketClass, number> = { person: 0, task: 1, routine: 2 };

export function lineOrder(a: Ticket, b: Ticket): number {
  return RANK[a.class] - RANK[b.class] || a.seq - b.seq;
}

export function queuedInOrder(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.state === "queued").sort(lineOrder);
}

export interface Snapshot {
  now: number;
  settings: TaskLineSettings;
  tickets: readonly Ticket[];
  machines: readonly Machine[];
}

export interface Admission {
  ticketId: string;
  machineId: string;
  reuse: boolean;
}

export interface Settlement {
  expire: string[];
  release: string[];
  stop: string[];
  admit: Admission[];
  newMachines: Machine[];
  idle: Array<{ machineId: string; since: number }>;
}

export type MachineNamer = (ticket: Ticket) => string;

export function settle(snapshot: Snapshot, nameMachine: MachineNamer): Settlement {
  const { now, settings } = snapshot;
  const out: Settlement = { expire: [], release: [], stop: [], admit: [], newMachines: [], idle: [] };
  const machines = new Map(snapshot.machines.map((machine) => [machine.id, { ...machine }]));
  const tickets = snapshot.tickets.map((ticket) => ({ ...ticket }));

  for (const ticket of tickets) {
    if (ticket.state === "queued" && now - ticket.polledAt > UNPOLLED_DROP_MS) {
      ticket.state = "expired";
      out.expire.push(ticket.id);
    }
    if (ticket.state === "admitted" && ticket.leaseUntil !== undefined && now > ticket.leaseUntil) {
      ticket.state = "expired";
      out.release.push(ticket.id);
      const machine = ticket.machineId === undefined ? undefined : machines.get(ticket.machineId);
      if (machine && machine.ticketId === ticket.id) {
        delete machine.ticketId;
        machine.idleSince = ticket.leaseUntil;
        out.idle.push({ machineId: machine.id, since: ticket.leaseUntil });
      }
    }
  }

  const idleMs = settings.idleMinutes * MINUTE;
  for (const machine of machines.values()) {
    if (machine.ticketId === undefined && machine.idleSince !== undefined && now - machine.idleSince >= idleMs) {
      machines.delete(machine.id);
      out.stop.push(machine.id);
    }
  }

  const byThread = (ticket: Ticket) => [...machines.values()].find((machine) => machine.thread === ticket.thread && machine.dog === ticket.dog);
  const idleMachines = () =>
    [...machines.values()].filter((machine) => machine.ticketId === undefined).sort((a, b) => (a.idleSince ?? a.startedAt) - (b.idleSince ?? b.startedAt) || a.startedAt - b.startedAt);

  const admitOn = (ticket: Ticket, machine: Machine, reuse: boolean) => {
    ticket.state = "admitted";
    machine.ticketId = ticket.id;
    delete machine.idleSince;
    out.admit.push({ ticketId: ticket.id, machineId: machine.id, reuse });
  };

  const waiting = queuedInOrder(tickets);
  for (const ticket of waiting) {
    const own = byThread(ticket);
    if (own && own.ticketId === undefined && own.size === ticket.size) admitOn(ticket, own, true);
  }
  const wanted = (machine: Machine) => waiting.some((ticket) => ticket.state === "queued" && ticket.thread === machine.thread && ticket.dog === machine.dog);
  for (const ticket of waiting) {
    if (ticket.state !== "queued") continue;
    const own = byThread(ticket);
    if (own) {
      if (own.ticketId !== undefined) continue;
      machines.delete(own.id);
      out.stop.push(own.id);
    }
    if (machines.size >= settings.cap) {
      const spare = idleMachines().find((machine) => !wanted(machine));
      if (!spare) continue;
      machines.delete(spare.id);
      out.stop.push(spare.id);
    }
    const machine: Machine = { id: nameMachine(ticket), thread: ticket.thread, ...(ticket.dog === undefined ? {} : { dog: ticket.dog }), size: ticket.size, startedAt: now };
    machines.set(machine.id, machine);
    out.newMachines.push(machine);
    admitOn(ticket, machine, false);
  }
  out.newMachines = out.newMachines.filter((machine) => machines.has(machine.id));
  return out;
}

export function placeOf(ticket: Ticket, tickets: readonly Ticket[]): number | undefined {
  if (ticket.state !== "queued") return undefined;
  const index = queuedInOrder(tickets).findIndex((other) => other.id === ticket.id);
  return index < 0 ? undefined : index + 1;
}

export function nextCheckAt(snapshot: Snapshot): number | undefined {
  const live = snapshot.tickets.some((ticket) => ticket.state === "queued" || ticket.state === "admitted") || snapshot.machines.length > 0;
  return live ? snapshot.now + RECONCILE_MS : undefined;
}
