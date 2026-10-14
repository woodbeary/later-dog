import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const folder = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), write: z.boolean() }).strict();
export const sharedComputerRegistration = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), environmentId: z.string().uuid(),
  folders: z.array(folder).max(20), terminal: z.boolean(), computer: z.boolean(), home: z.boolean().optional(),
}).strict().refine(registration => !registration.home || registration.folders.length === 1, { message: "A home grant lends exactly one folder" });
export const sharedComputerOperation = z.object({
  computer_id: z.string().uuid().optional(),
  action: z.enum(["list_files", "read_file", "write_file", "run_command", "computer_tools", "computer_call"]),
  folder_id: z.string().uuid().optional(), path: z.string().max(2048).optional(),
  content: z.string().max(350_000).optional(), encoding: z.enum(["utf8", "base64"]).optional(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.number().int().min(0).max(64 * 1024 * 1024).optional(), length: z.number().int().min(1).max(256 * 1024).optional(),
  command: z.string().max(8000).optional(), tool_name: z.string().max(100).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();
type Registration = z.infer<typeof sharedComputerRegistration>;
type Operation = z.infer<typeof sharedComputerOperation>;
export type SharedComputerRegistration = Registration;
export type SharedComputerOperation = Operation;
export type SharedComputerOwner = { session: string; person: string };
export type KnownComputer = { id: string; name: string; person: string; session: string; home: boolean; lastSeenAt: number };
export type SharedComputerStatus = {
  id: string; name: string; online: boolean; busy: boolean; lastSeenAt: number;
  scopes: { folders: { id: string; name: string; write: boolean }[]; terminal: boolean; screen: boolean };
};
type Job = { id: string; operation: Operation; active: () => boolean; sent: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Computer = { registration: Registration; owner: SharedComputerOwner; secret: string; seen: number; jobs: Map<string, Job>; wake?: () => void; polls: number };
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
const TOTAL = 100;
const RETAIN_MS = 14 * 24 * 60 * 60_000;
const OFFLINE = "This shared computer is offline. Keep its desktop app open; do not substitute files on the server.";
const NOT_YOURS = "This conversation cannot use a shared computer: only a conversation started by the person who shared it can.";
const knownFile = z.object({
  version: z.literal(1),
  computers: z.array(z.object({
    id: z.string().uuid(), name: z.string().min(1).max(120), person: z.string().min(1).max(200), session: z.string().min(1).max(200),
    home: z.boolean(), lastSeenAt: z.number().int().nonnegative(),
  }).strict()).max(TOTAL),
}).strict();

export function sharedComputerScopeRefusal(registration: Registration, operation: Pick<Operation, "action" | "folder_id">): string | null {
  switch (operation.action) {
    case "run_command":
      return registration.terminal ? null : "Terminal access is not lent to this server.";
    case "computer_tools":
    case "computer_call":
      return registration.computer ? null : "Apps and screen are not lent to this server.";
    case "list_files":
    case "read_file":
    case "write_file": {
      if (!operation.folder_id) return "Pass folder_id from list_shared_computers.";
      const lent = registration.folders.find(entry => entry.id === operation.folder_id);
      if (!lent) return "This folder has not been shared with this server.";
      return operation.action === "write_file" && !lent.write ? "This folder is read-only." : null;
    }
  }
}

export function completeSharedOperation(registration: Registration, operation: Operation): Operation & { computer_id: string } {
  const files = operation.action === "list_files" || operation.action === "read_file" || operation.action === "write_file";
  const folderId = operation.folder_id ?? (files && registration.folders.length === 1 ? registration.folders[0]!.id : undefined);
  const path = registration.home && operation.path !== undefined ? homeRelative(operation.path) : operation.path;
  return { ...operation, computer_id: registration.id, ...(folderId ? { folder_id: folderId } : {}), ...(path !== undefined ? { path } : {}) };
}

function homeRelative(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~" || trimmed === "~/") return ".";
  return trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
}

export function provenRequestPerson(
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean } | undefined,
  generation: string,
  personOf: (messageId: string) => string | undefined,
): string | null {
  if (!request?.messageId || request.stopped || !request.generations.has(generation)) return null;
  return personOf(request.messageId) ?? null;
}

export class SharedComputers {
  private computers = new Map<string, Computer>();
  private sessionLive: (id: string) => boolean;
  private file: string | null;
  private remembered: KnownComputer[];
  private waiters = new Set<{ person: string; done: (online: boolean) => void }>();
  constructor(sessionLive: (id: string) => boolean, options: { file?: string } = {}) {
    this.sessionLive = sessionLive;
    this.file = options.file ?? null;
    this.remembered = this.load();
  }
  private static key(session: string, id: string) { return `${session}\n${id}`; }
  register(registration: Registration, owner: SharedComputerOwner, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw failure("Invalid computer credential", 400);
    const key = SharedComputers.key(owner.session, registration.id);
    const old = this.computers.get(key);
    if (old) {
      this.authorize(registration.id, owner.session, secret);
      old.registration = registration; old.seen = Date.now();
      this.remember(registration, owner);
      this.arrived(owner.person);
      return;
    }
    this.reap();
    for (const [stale, entry] of this.computers) {
      if (entry.owner.session !== owner.session) continue;
      this.computers.delete(stale); entry.wake?.();
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("This computer's access changed. An in-flight action may have completed; inspect before retrying."));
    }
    if (this.computers.size >= TOTAL) throw failure("Too many shared computers");
    this.computers.set(key, { registration, owner: { ...owner }, secret, seen: Date.now(), jobs: new Map(), polls: 0 });
    this.remember(registration, owner);
    this.arrived(owner.person);
  }
  known(principal: string | null): (KnownComputer & { online: boolean })[] {
    if (!principal) return [];
    const now = Date.now();
    return this.remembered
      .filter(entry => entry.person === principal && this.sessionLive(entry.session) && now - entry.lastSeenAt < RETAIN_MS)
      .map(entry => {
        const live = this.computers.get(SharedComputers.key(entry.session, entry.id));
        return { ...entry, lastSeenAt: live ? Math.max(entry.lastSeenAt, live.seen) : entry.lastSeenAt, online: live !== undefined && this.online(live) };
      });
  }
  pick(principal: string | null, computerId?: string): Registration | null {
    if (!principal) throw failure(NOT_YOURS, 403);
    const online = [...this.computers.values()].filter(entry => entry.owner.person === principal && this.online(entry));
    if (computerId) return online.find(entry => entry.registration.id === computerId)?.registration ?? null;
    if (online.length <= 1) return online[0]?.registration ?? null;
    const names = online.map(entry => `${entry.registration.name} (computer_id ${entry.registration.id})`).join(", ");
    throw failure(`More than one computer is online: ${names}. Ask which one they mean, then pass its computer_id.`);
  }
  waitOnline(principal: string | null, ms: number): Promise<boolean> {
    if (!principal) return Promise.resolve(false);
    if (this.list(principal).length > 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiter = {
        person: principal,
        done: (online: boolean) => { clearTimeout(timer); this.waiters.delete(waiter); resolve(online); },
      };
      const timer = setTimeout(() => waiter.done(false), ms);
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }
  private arrived(person: string) {
    for (const waiter of this.waiters) if (waiter.person === person) waiter.done(true);
  }
  private reap() {
    for (const [key, entry] of this.computers) {
      if (entry.jobs.size === 0 && (!this.sessionLive(entry.owner.session) || Date.now() - entry.seen > RETAIN_MS)) this.computers.delete(key);
    }
  }
  private online(entry: Computer) { return this.sessionLive(entry.owner.session) && Date.now() - entry.seen < 40_000; }
  private authorize(id: string, session: string, secret: string) {
    const entry = this.computers.get(SharedComputers.key(session, id));
    if (!entry || !this.sessionLive(session) || !/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(secret), Buffer.from(entry.secret))) throw failure("Shared computer is disconnected or not authorized", 403);
    return entry;
  }
  list(principal: string | null) {
    if (!principal) return [];
    return [...this.computers.values()].filter(entry => entry.owner.person === principal && this.online(entry)).map(entry => entry.registration);
  }
  status(principal: string | null): SharedComputerStatus[] {
    if (!principal) return [];
    this.reap();
    return [...this.computers.values()].filter(entry => entry.owner.person === principal).map(entry => ({
      id: entry.registration.id, name: entry.registration.name, online: this.online(entry), busy: entry.jobs.size > 0, lastSeenAt: entry.seen,
      scopes: {
        folders: entry.registration.folders.map(({ id, name, write }) => ({ id, name, write })),
        terminal: entry.registration.terminal, screen: entry.registration.computer,
      },
    }));
  }
  async poll(id: string, session: string, secret: string) {
    const entry = this.authorize(id, session, secret);
    const turn = ++entry.polls;
    entry.wake?.();
    entry.seen = Date.now();
    this.arrived(entry.owner.person);
    const next = () => {
      for (const job of entry.jobs.values()) {
        if (!job.active()) { this.finish(entry, job, failure("The requesting turn ended")); continue; }
        if (!job.sent) { job.sent = true; return { id: job.id, operation: job.operation }; }
      }
      return null;
    };
    const queued = next();
    if (queued) return queued;
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); if (entry.wake === wake) entry.wake = undefined; resolve(); };
      const timer = setTimeout(wake, 20_000);
      entry.wake = wake;
    });
    this.authorize(id, session, secret);
    if (entry.polls !== turn) return null;
    entry.seen = Date.now();
    return next();
  }
  liveJob(id: string, session: string, secret: string, jobId: string) {
    const entry = this.authorize(id, session, secret);
    entry.seen = Date.now();
    const job = entry.jobs.get(jobId);
    return job?.sent === true && job.active();
  }
  complete(id: string, session: string, secret: string, jobId: string, result: unknown) {
    const entry = this.authorize(id, session, secret);
    const job = entry.jobs.get(jobId);
    if (!job || !job.sent) throw failure("This computer operation expired; it will not be replayed");
    this.finish(entry, job, job.active() ? null : failure("The requesting turn ended"), result);
  }
  disconnect(id: string, session: string, secret: string) {
    const entry = this.authorize(id, session, secret);
    this.computers.delete(SharedComputers.key(session, id)); entry.wake?.();
    this.forget(entry => entry.session === session && entry.id === id);
    for (const job of entry.jobs.values()) this.finish(entry, job, failure("Computer disconnected. An in-flight action may have completed; inspect before retrying."));
  }
  request(requested: Operation, principal: string | null, active: () => boolean): Promise<unknown> {
    let registration: Registration | null;
    try { registration = this.pick(principal, requested.computer_id); } catch (error) { return Promise.reject(error); }
    const entry = registration && [...this.computers.values()].find(candidate => candidate.registration === registration);
    if (!entry) return Promise.reject(failure(OFFLINE));
    const operation = completeSharedOperation(entry.registration, requested);
    const refusal = sharedComputerScopeRefusal(entry.registration, operation);
    if (refusal) return Promise.reject(failure(refusal, 403));
    if (entry.jobs.size >= 1) return Promise.reject(failure("This shared computer is busy. Wait for its current action to finish."));
    if (!active()) return Promise.reject(failure("The requesting turn ended", 401));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const job: Job = { id, operation, active, sent: false, resolve, reject, timer: setTimeout(() => this.finish(entry, job, failure("Computer action timed out. Its outcome is unknown; inspect before retrying.")), 45_000) };
      entry.jobs.set(id, job); entry.wake?.();
    });
  }
  close() {
    for (const entry of this.computers.values()) {
      entry.wake?.();
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("Workspace stopped. Inspect any in-flight action before retrying."));
    }
    this.computers.clear();
    for (const waiter of this.waiters) waiter.done(false);
  }
  private remember(registration: Registration, owner: SharedComputerOwner) {
    if (!this.file) return;
    const now = Date.now();
    const kept = this.remembered.filter(entry =>
      entry.session !== owner.session && !(entry.person === owner.person && entry.id === registration.id)
      && this.sessionLive(entry.session) && now - entry.lastSeenAt < RETAIN_MS);
    this.remembered = [...kept, { id: registration.id, name: registration.name, person: owner.person, session: owner.session, home: registration.home === true, lastSeenAt: now }].slice(-TOTAL);
    this.save();
  }
  private forget(match: (entry: KnownComputer) => boolean) {
    if (!this.file) return;
    const kept = this.remembered.filter(entry => !match(entry));
    if (kept.length === this.remembered.length) return;
    this.remembered = kept;
    this.save();
  }
  private load(): KnownComputer[] {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000) return [];
      return knownFile.parse(JSON.parse(readFileSync(this.file, "utf8"))).computers;
    } catch (error) {
      console.warn(`shared computers: could not read known computers: ${(error as Error).message}`);
      return [];
    }
  }
  private save() {
    if (!this.file) return;
    try { writeFileAtomic(this.file, JSON.stringify({ version: 1, computers: this.remembered }), { mode: 0o600 }); }
    catch (error) { console.warn(`shared computers: could not save known computers: ${(error as Error).message}`); }
  }
  private finish(entry: Computer, job: Job, error: Error | null, result?: unknown) {
    clearTimeout(job.timer); entry.jobs.delete(job.id);
    if (error) job.reject(error); else job.resolve(result);
  }
}
