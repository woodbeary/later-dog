import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { computersConnection, computersKey } from "./cloud-computers.ts";
import { notePlacement, REMOTE_ENGINES_FILE, type EngineOpener } from "./engine-placement.ts";
import type { EngineLink } from "./engine-remote.ts";
import type { MachineSize } from "./machine-size-words.ts";

export const TASK_LINE_WAIT_SECONDS = 20;
export const TASK_QUEUE_BUDGET_MS = 20 * 60_000;
export const TASK_LEASE_RENEW_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;

export type TicketClass = "person" | "task" | "routine";

export interface TaskMachineSetting { enabled: boolean; bots?: string[] }

export function taskMachineSetting(dataDir: string): TaskMachineSetting {
  try {
    const saved = (JSON.parse(readFileSync(join(dataDir, REMOTE_ENGINES_FILE), "utf8")) as { taskMachines?: { enabled?: unknown; bots?: unknown } }).taskMachines;
    const bots = Array.isArray(saved?.bots) ? saved.bots.filter((id): id is string => typeof id === "string") : undefined;
    return { enabled: saved?.enabled === true, ...(bots ? { bots } : {}) };
  } catch { return { enabled: false }; }
}

export function saveTaskMachineSetting(dataDir: string, setting: TaskMachineSetting): TaskMachineSetting {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(join(dataDir, REMOTE_ENGINES_FILE), "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The saved engine placement could not be read, so it was left unchanged."); }
  const taskMachines = { enabled: setting.enabled, ...(setting.bots ? { bots: [...new Set(setting.bots)] } : {}) };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dataDir, REMOTE_ENGINES_FILE), `${JSON.stringify({ ...saved, taskMachines }, null, 2)}\n`, { mode: 0o600 });
  return taskMachines;
}

export function taskMachineChosen(setting: TaskMachineSetting, botId: string): boolean {
  return setting.enabled && (!setting.bots || setting.bots.includes(botId));
}

export interface TicketView {
  id: string;
  state: "queued" | "admitted" | "released" | "cancelled" | "expired";
  place?: number;
  ahead?: number;
  machine?: { id: string; size: MachineSize; computerSize: string; reused: boolean };
  cap: number;
  running: number;
}

export interface TaskLineService {
  take(input: { key: string; thread: string; dog: string; size: MachineSize; class: TicketClass }, signal?: AbortSignal): Promise<TicketView>;
  ticket(id: string, waitSeconds: number, signal?: AbortSignal): Promise<TicketView | null>;
  drop(id: string): Promise<void>;
  line(): Promise<unknown>;
  configure(settings: { cap?: number; idleMinutes?: number }): Promise<unknown>;
}

export function taskLineService(): TaskLineService | null {
  const connection = computersConnection();
  if (!connection || connection.source === "trial") return null;
  const root = `${connection.api.replace(/\/v1$/, "")}/v1/task-line`;
  const base = `${root}/tickets`;
  const headers = { authorization: `Bearer ${computersKey(connection)}`, "content-type": "application/json", accept: "application/json" };
  const timed = (ms: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const read = async (response: Response): Promise<TicketView> => {
    const body = await response.json().catch(() => null) as { ticket?: TicketView; error?: { code?: string; message?: string } } | null;
    if (!response.ok || !body?.ticket) throw new Error(`the task line answered ${response.status}${body?.error ? ` ${body.error.code}: ${body.error.message}` : ""}`);
    return body.ticket;
  };
  return {
    async take(input, signal) {
      return read(await fetch(base, { method: "POST", headers, body: JSON.stringify(input), signal: timed(CALL_TIMEOUT_MS, signal) }));
    },
    async ticket(id, waitSeconds, signal) {
      const response = await fetch(`${base}/${id}${waitSeconds > 0 ? `?wait=${waitSeconds}` : ""}`, { headers, signal: timed(CALL_TIMEOUT_MS + waitSeconds * 1000, signal) });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      return read(response);
    },
    async line() {
      const response = await fetch(root, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const body = await response.json().catch(() => null) as { line?: unknown } | null;
      if (!response.ok || !body?.line) throw new Error(`the task line answered ${response.status}`);
      return body.line;
    },
    async configure(settings) {
      const response = await fetch(`${root}/settings`, { method: "PUT", headers, body: JSON.stringify(settings), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const body = await response.json().catch(() => null) as { line?: unknown; error?: { message?: string } } | null;
      if (!response.ok || !body?.line) throw new Error(`the task line refused the settings: ${body?.error?.message ?? response.status}`);
      return body.line;
    },
    async drop(id) {
      try {
        const response = await fetch(`${base}/${id}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
        await response.body?.cancel();
      } catch {}
    },
  };
}

export type TaskMachineOpen = (machineId: string, botId: string, plan: Parameters<EngineOpener["open"]>[1], signal?: AbortSignal) => Promise<EngineLink>;

export interface TaskMachineOptions {
  dataDir: string;
  ticketClass: (botId: string, threadId: string) => TicketClass | null;
  size: (botId: string, threadId: string) => MachineSize;
  openOn: TaskMachineOpen;
  service?: () => TaskLineService | null;
  queueBudgetMs?: number;
  renewMs?: number;
}

export class TaskLineWaitTooLong extends Error {}

async function admitted(line: TaskLineService, first: TicketView, budgetMs: number, note: (text: string) => void, signal?: AbortSignal): Promise<TicketView> {
  let ticket = first;
  const deadline = Date.now() + budgetMs;
  let lastPlace = ticket.place;
  while (ticket.state === "queued") {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new TaskLineWaitTooLong(`still waiting at place ${ticket.place ?? "?"} after ${Math.round(budgetMs / 1000)} s`);
    const next = await line.ticket(ticket.id, Math.max(1, Math.min(TASK_LINE_WAIT_SECONDS, Math.ceil((deadline - Date.now()) / 1000))), signal);
    if (!next) throw new Error("the task line forgot the ticket");
    ticket = next;
    if (ticket.state === "queued" && ticket.place !== lastPlace) {
      lastPlace = ticket.place;
      note(`waiting for a machine: place ${ticket.place} (${ticket.ahead} ahead), ${ticket.running} of ${ticket.cap} running`);
    }
  }
  if (ticket.state !== "admitted" || !ticket.machine) throw new Error(`the ticket ended ${ticket.state} before a machine was free`);
  return ticket;
}

const TURN_ENDS = ['"type":"result"', '"method":"turn/completed"', '"type":"turn.completed"'];
const TAIL = Math.max(...TURN_ENDS.map((end) => end.length));
const STDOUT_DATA = /"type":"stdout".*?"data":"([A-Za-z0-9+/=]*)"/;

export function turnEnded(frame: string, tail: { text: string }): boolean {
  if (frame.includes('"type":"native_exit"')) return true;
  const data = STDOUT_DATA.exec(frame)?.[1];
  if (!data) return false;
  const text = tail.text + Buffer.from(data, "base64").toString("utf8");
  tail.text = text.slice(-TAIL);
  return TURN_ENDS.some((end) => text.includes(end));
}

export interface LeaseTurn { thread: string; dog: string; size: MachineSize; class: TicketClass; machineId: string }

function holdLease(line: TaskLineService, first: string, link: EngineLink, turn: LeaseTurn, renewMs: number, note: (text: string) => void): void {
  let ticketId: string | null = first;
  let taking = false;
  const tail = { text: "" };
  const renew = () => {
    if (!ticketId) return;
    const id = ticketId;
    void line.ticket(id, 0).then(
      (ticket) => { if (!ticket || ticket.state !== "admitted") { note(`lease on ${id} ended (${ticket?.state ?? "gone"})`); if (ticketId === id) ticketId = null; } },
      () => undefined,
    );
  };
  const release = (why: string) => {
    if (!ticketId) return;
    const id = ticketId;
    ticketId = null;
    tail.text = "";
    note(`turn ended on ${turn.machineId} (${why}); its slot is free and the machine idles out unless the chat comes back`);
    void line.drop(id);
  };
  const retake = () => {
    if (ticketId || taking) return;
    taking = true;
    void line.take({ key: `${turn.dog}:${turn.thread}:${randomUUID()}`, thread: turn.thread, dog: turn.dog, size: turn.size, class: turn.class }).then(
      (ticket) => {
        if (ticket.state === "admitted" && ticket.machine?.id === turn.machineId) { ticketId = ticket.id; note(`next turn holds ${turn.machineId} again`); }
        else { note(`next turn found ${turn.machineId} given away (${ticket.state}); the warm engine carries on without a slot`); void line.drop(ticket.id); }
      },
      () => undefined,
    ).finally(() => { taking = false; });
  };
  const send = link.send.bind(link);
  link.send = (frame: string) => {
    if (!ticketId && frame.startsWith('{"type":"stdin"')) retake();
    send(frame);
  };
  link.on("line", (frame: string) => { if (ticketId && turnEnded(frame, tail)) release(frame.includes("native_exit") ? "engine exited" : "reply finished"); });
  const timer = setInterval(renew, renewMs);
  timer.unref?.();
  link.once("close", () => {
    clearInterval(timer);
    if (ticketId) void line.drop(ticketId);
    ticketId = null;
  });
}

export function taskMachineOpener(inner: EngineOpener, options: TaskMachineOptions): EngineOpener {
  const service = options.service ?? taskLineService;
  const queueBudgetMs = options.queueBudgetMs ?? TASK_QUEUE_BUDGET_MS;
  return {
    get proxyPath() { return inner.proxyPath; },
    get guestProvider() { return inner.guestProvider; },
    get remoteBase() { return inner.remoteBase; },
    openBudgetMs: (inner.openBudgetMs ?? 0) + queueBudgetMs,
    async open(botId, plan, signal) {
      const ticketClass = taskMachineChosen(taskMachineSetting(options.dataDir), botId) ? options.ticketClass(botId, plan.threadId) : null;
      if (!ticketClass) return inner.open(botId, plan, signal);
      const who = `${botId.slice(0, 8)} ${plan.threadId.slice(0, 8)}`;
      const note = (text: string) => notePlacement(options.dataDir, `[task-line] ${who} ${text}`);
      const began = Date.now();
      const line = service();
      if (!line) {
        note("falls back to the dog's computer: this home has no computers service for task machines");
        return inner.open(botId, plan, signal);
      }
      const size = options.size(botId, plan.threadId);
      let ticketId: string | undefined;
      try {
        const first = await line.take({ key: `${botId}:${plan.threadId}:${randomUUID()}`, thread: plan.threadId, dog: botId, size, class: ticketClass }, signal);
        ticketId = first.id;
        note(first.state === "queued"
          ? `waiting for a ${size} machine: place ${first.place} (${first.ahead} ahead), ${first.running} of ${first.cap} running`
          : `admitted on ${first.machine?.id} (${size}${first.machine?.reused ? ", reused" : ""}), ${first.running} of ${first.cap} running`);
        const ticket = await admitted(line, first, queueBudgetMs, note, signal);
        const machineId = ticket.machine!.id;
        const waited = Date.now() - began;
        const link = await options.openOn(machineId, botId, plan, signal);
        holdLease(line, ticket.id, link, { thread: plan.threadId, dog: botId, size, class: ticketClass, machineId }, options.renewMs ?? TASK_LEASE_RENEW_MS, note);
        note(`engine opened on task machine ${machineId} (${size}) in ${Date.now() - began} ms, ${waited} ms of it in line`);
        return link;
      } catch (error) {
        if (ticketId) void line.drop(ticketId);
        if (signal?.aborted) throw error;
        note(`falls back to the dog's computer after ${Date.now() - began} ms: ${error instanceof Error ? error.message : String(error)}`);
        return inner.open(botId, plan, signal);
      }
    },
  };
}
