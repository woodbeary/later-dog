import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

export const PHONE_JOBS = ["calendar", "reminders", "contacts", "location", "add_calendar_event", "add_reminder", "change_calendar_event", "change_reminder"] as const;
export type PhoneJobKind = (typeof PHONE_JOBS)[number];

export const PHONE_READS = ["calendar", "reminders", "contacts", "location"] as const;
export const PHONE_ADDS = ["calendar_event", "reminder"] as const;

const MOMENT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const moment = z.string().trim().regex(MOMENT, "Use an ISO date or date-time, such as 2026-11-03 or 2026-11-03T14:30 (the phone's own time zone) or 2026-11-03T14:30-08:00.");
const text = (max: number) => z.string().trim().min(1).max(max);

export const phoneRead = z.object({
  what: z.enum(PHONE_READS),
  from: moment.optional(),
  to: moment.optional(),
  search: text(200).optional(),
  query: text(100).optional(),
  include_completed: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().superRefine((read, context) => {
  if (read.what === "contacts" && !read.query) context.addIssue({ code: "custom", path: ["query"], message: "contacts needs query: a name to look up." });
});

export const phoneAdd = z.object({
  what: z.enum(PHONE_ADDS),
  title: text(300),
  start: moment.optional(),
  end: moment.optional(),
  all_day: z.boolean().optional(),
  due: moment.optional(),
  location: text(500).optional(),
  notes: text(4000).optional(),
  calendar: text(200).optional(),
  list: text(200).optional(),
}).strict().superRefine((add, context) => {
  if (add.what === "calendar_event" && !add.start) context.addIssue({ code: "custom", path: ["start"], message: "calendar_event needs start." });
});

export const phoneChange = z.object({
  what: z.enum(PHONE_ADDS),
  id: text(500),
  title: text(300).optional(),
  start: moment.optional(),
  end: moment.optional(),
  all_day: z.boolean().optional(),
  due: moment.optional(),
  completed: z.boolean().optional(),
  location: text(500).optional(),
  notes: text(4000).optional(),
}).strict().superRefine((change, context) => {
  const { what: _what, id: _id, ...changes } = change;
  if (Object.keys(changes).length === 0) context.addIssue({ code: "custom", path: ["id"], message: "Say what to change: title, start, end, all_day, location or notes for an event; completed, title, due or notes for a reminder." });
  const eventOnly = ["start", "end", "all_day", "location"].filter((field) => field in changes);
  const reminderOnly = ["due", "completed"].filter((field) => field in changes);
  if (change.what === "reminder" && eventOnly.length) context.addIssue({ code: "custom", path: [eventOnly[0]!], message: "A reminder has due, completed, title and notes." });
  if (change.what === "calendar_event" && reminderOnly.length) context.addIssue({ code: "custom", path: [reminderOnly[0]!], message: "An event has title, start, end, all_day, location and notes." });
});

export type PhoneRead = z.infer<typeof phoneRead>;
export type PhoneChange = z.infer<typeof phoneChange>;
export type PhoneAdd = z.infer<typeof phoneAdd>;
export type PhoneJob = { kind: PhoneJobKind; arguments: Record<string, unknown> };
const PHONE_ADD_JOBS: ReadonlySet<PhoneJobKind> = new Set(["add_calendar_event", "add_reminder"]);

export function readJob(read: PhoneRead): PhoneJob {
  const { what, ...rest } = read;
  return { kind: what, arguments: rest };
}

export function addJob(add: PhoneAdd): PhoneJob {
  const { what, ...rest } = add;
  return { kind: what === "calendar_event" ? "add_calendar_event" : "add_reminder", arguments: rest };
}

export function changeJob(change: PhoneChange): PhoneJob {
  const { what, ...rest } = change;
  return { kind: what === "calendar_event" ? "change_calendar_event" : "change_reminder", arguments: rest };
}

export const phoneRegistration = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  can: z.array(z.enum(PHONE_JOBS)).max(PHONE_JOBS.length),
}).strict();

export const phoneResult = z.union([
  z.object({ jobId: z.string().uuid(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ jobId: z.string().uuid(), ok: z.literal(false), error: z.string().max(2000) }).strict(),
]);

export type PhoneRegistration = z.infer<typeof phoneRegistration>;
export type PhoneOwner = { session: string; person: string };
export type KnownPhone = { id: string; name: string; person: string; session: string; can: PhoneJobKind[]; lastSeenAt: number };
export type PhoneStatus = { id: string; name: string; online: boolean; can: PhoneJobKind[]; lastSeenAt: number };

const ONLINE_MS = 40_000;
const POLL_MS = 20_000;
const JOB_MS = 120_000;
const JOBS_PER_PERSON = 4;
const PHONES = 20;
const RETAIN_MS = 30 * 24 * 60 * 60_000;
const RESULT_BYTES = 200_000;

export const PHONE_WAIT_MS = 60_000;

const ACTIVITY: Record<PhoneJobKind, string> = {
  calendar: "check your calendar",
  reminders: "check your reminders",
  contacts: "look someone up in your contacts",
  location: "see where you are",
  add_calendar_event: "add an event to your calendar",
  add_reminder: "add a reminder",
  change_calendar_event: "change an event on your calendar",
  change_reminder: "update a reminder",
};

export function phoneWants(kind: PhoneJobKind): string {
  return ACTIVITY[kind];
}

export const PHONE_NOT_YOURS = "Only the person who owns this later.dog can let a dog use their phone, and only in their own conversations.";

export const NO_PHONE = "No iPhone has connected to lend itself yet: later.dog isn't open on their iPhone, or it's a version from before dogs could use the phone. Tell them in one line to open later.dog on their iPhone, updated and signed in with the same email, then ask again.";

export function phoneTooOld(kind: PhoneJobKind): string {
  return `later.dog on the person's iPhone can't ${ACTIVITY[kind]} yet: that needs the next version of the iPhone app. Tell them in one line, and do it another way meanwhile if you can.`;
}

export function phoneDidNotOpen(kind: PhoneJobKind, seconds: number): string {
  return `The person got a notification to open later.dog so you could ${ACTIVITY[kind]}, but the app didn't open within ${seconds} seconds. Tell them in one line that you need later.dog open on their iPhone for this, and stop; when they open it, they can ask again.`;
}

type Job = {
  id: string; person: string; job: PhoneJob; active: () => boolean; sentTo: string | null; done: boolean;
  resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
};
type Phone = { registration: PhoneRegistration; owner: PhoneOwner; secret: string; seen: number; wake?: () => void; polls: number };

const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
const knownFile = z.object({
  version: z.literal(1),
  phones: z.array(z.object({
    id: z.string().uuid(), name: z.string().min(1).max(120), person: z.string().min(1).max(200), session: z.string().min(1).max(200),
    can: z.array(z.enum(PHONE_JOBS)).max(PHONE_JOBS.length), lastSeenAt: z.number().int().nonnegative(),
  }).strict()).max(PHONES),
}).strict();

export interface PhoneDeskOptions {
  file?: string;
  now?: () => number;
  pollMs?: number;
  jobMs?: number;
}

export class PhoneDesk {
  private phones = new Map<string, Phone>();
  private jobs = new Map<string, Job>();
  private remembered: KnownPhone[];
  private waiters = new Set<{ person: string; kind: PhoneJobKind; done: (online: boolean) => void }>();
  private readonly sessionLive: (id: string) => boolean;
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly jobMs: number;

  constructor(sessionLive: (id: string) => boolean, options: PhoneDeskOptions = {}) {
    this.sessionLive = sessionLive;
    this.file = options.file ?? null;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.jobMs = options.jobMs ?? JOB_MS;
    this.remembered = this.load();
  }

  private static key(session: string, id: string) { return `${session}\n${id}`; }

  connect(registration: PhoneRegistration, owner: PhoneOwner, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw failure("Invalid phone credential", 400);
    const key = PhoneDesk.key(owner.session, registration.id);
    const old = this.phones.get(key);
    if (old && !this.matches(old, secret)) this.restarted(key);
    for (const [stale, entry] of this.phones) {
      if (stale === key || entry.registration.id !== registration.id || entry.owner.person !== owner.person) continue;
      this.phones.delete(stale);
      entry.wake?.();
      this.restarted(stale);
    }
    if (!old && this.phones.size >= PHONES) throw failure("Too many phones");
    this.phones.set(key, { registration, owner: { ...owner }, secret, seen: this.now(), polls: old?.polls ?? 0, ...(old?.wake ? { wake: old.wake } : {}) });
    old?.wake?.();
    this.remember(registration, owner);
    this.arrived(owner.person);
  }

  known(person: string | null): (KnownPhone & { online: boolean })[] {
    if (!person) return [];
    const now = this.now();
    return this.remembered
      .filter((entry) => entry.person === person && this.sessionLive(entry.session) && now - entry.lastSeenAt < RETAIN_MS)
      .map((entry) => {
        const live = this.phones.get(PhoneDesk.key(entry.session, entry.id));
        return { ...entry, lastSeenAt: live ? Math.max(entry.lastSeenAt, live.seen) : entry.lastSeenAt, online: live !== undefined && this.online(live) };
      });
  }

  status(person: string | null): PhoneStatus[] {
    return this.known(person).map(({ id, name, online, can, lastSeenAt }) => ({ id, name, online, can, lastSeenAt }));
  }

  async poll(id: string, session: string, secret: string, gone?: AbortSignal): Promise<{ id: string; kind: PhoneJobKind; arguments: Record<string, unknown> } | null> {
    const key = PhoneDesk.key(session, id);
    const entry = this.authorize(id, session, secret);
    const turn = ++entry.polls;
    entry.wake?.();
    entry.seen = this.now();
    this.arrived(entry.owner.person);
    if (gone?.aborted) return null;
    const queued = this.next(key, entry);
    if (queued) return queued;
    await new Promise<void>((resolve) => {
      const wake = () => { clearTimeout(timer); gone?.removeEventListener("abort", wake); if (entry.wake === wake) entry.wake = undefined; resolve(); };
      const timer = setTimeout(wake, this.pollMs);
      timer.unref?.();
      entry.wake = wake;
      gone?.addEventListener("abort", wake, { once: true });
    });
    const current = this.phones.get(key);
    if (gone?.aborted || !current || current.polls !== turn || !this.matches(current, secret)) return null;
    current.seen = this.now();
    return this.next(key, current);
  }

  complete(id: string, session: string, secret: string, outcome: z.infer<typeof phoneResult>) {
    const key = PhoneDesk.key(session, id);
    const entry = this.authorize(id, session, secret);
    entry.seen = this.now();
    const job = this.jobs.get(outcome.jobId);
    if (!job || job.sentTo !== key) throw failure("This phone job expired; it will not be replayed");
    if (!job.active()) return this.finish(job, failure("The requesting turn ended"));
    if (!outcome.ok) return this.finish(job, failure(outcome.error));
    const size = Buffer.byteLength(JSON.stringify(outcome.result ?? null));
    if (size > RESULT_BYTES) return this.finish(job, failure(`The phone's answer was too big (${size} bytes). Ask for a shorter range or a smaller limit.`));
    this.finish(job, null, outcome.result);
  }

  disconnect(id: string, session: string, secret: string) {
    const key = PhoneDesk.key(session, id);
    const entry = this.authorize(id, session, secret);
    this.phones.delete(key);
    entry.wake?.();
    this.restarted(key);
  }

  async request(person: string | null, job: PhoneJob, active: () => boolean, call: (kind: PhoneJobKind) => Promise<void> | void, waitMs = PHONE_WAIT_MS): Promise<unknown> {
    const known = this.known(person);
    if (!person || known.length === 0) throw failure(NO_PHONE);
    if (!known.some((phone) => phone.can.includes(job.kind))) throw failure(phoneTooOld(job.kind));
    if (!this.ready(person, job.kind)) {
      await call(job.kind);
      if (!(await this.waitOnline(person, job.kind, waitMs))) throw failure(phoneDidNotOpen(job.kind, Math.round(waitMs / 1000)));
    }
    if (!active()) throw failure("The requesting turn ended", 401);
    if ([...this.jobs.values()].filter((queued) => queued.person === person).length >= JOBS_PER_PERSON) throw failure("The phone is busy with other requests. Wait a moment and try again.");
    return await new Promise((resolve, reject) => {
      const queued: Job = {
        id: randomUUID(), person, job, active, sentTo: null, done: false, resolve, reject,
        timer: setTimeout(() => this.finish(queued, failure("The phone didn't answer in time. If something was being added, check before adding it again.")), this.jobMs),
      };
      queued.timer.unref?.();
      this.jobs.set(queued.id, queued);
      for (const phone of this.phones.values()) if (phone.owner.person === person) phone.wake?.();
    });
  }

  close() {
    for (const entry of this.phones.values()) entry.wake?.();
    for (const job of this.jobs.values()) this.finish(job, failure("The home stopped. If something was being added, check before adding it again."));
    this.phones.clear();
    for (const waiter of this.waiters) waiter.done(false);
  }

  private next(key: string, entry: Phone) {
    for (const job of this.jobs.values()) {
      if (job.person !== entry.owner.person || job.sentTo !== null || !entry.registration.can.includes(job.job.kind)) continue;
      if (!job.active()) { this.finish(job, failure("The requesting turn ended")); continue; }
      job.sentTo = key;
      return { id: job.id, kind: job.job.kind, arguments: job.job.arguments };
    }
    return null;
  }

  private restarted(key: string) {
    for (const job of this.jobs.values()) {
      if (job.sentTo !== key) continue;
      if (PHONE_ADD_JOBS.has(job.job.kind)) this.finish(job, failure("later.dog on the phone closed while this was being added. Check whether it was added before adding it again."));
      else job.sentTo = null;
    }
    for (const phone of this.phones.values()) phone.wake?.();
  }

  private ready(person: string, kind: PhoneJobKind) {
    return [...this.phones.values()].some((entry) => entry.owner.person === person && this.online(entry) && entry.registration.can.includes(kind));
  }

  private waitOnline(person: string, kind: PhoneJobKind, ms: number): Promise<boolean> {
    if (this.ready(person, kind)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        person, kind,
        done: (online: boolean) => { clearTimeout(timer); this.waiters.delete(waiter); resolve(online); },
      };
      const timer = setTimeout(() => waiter.done(false), ms);
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  private arrived(person: string) {
    for (const waiter of this.waiters) if (waiter.person === person && this.ready(person, waiter.kind)) waiter.done(true);
  }

  private online(entry: Phone) {
    return this.sessionLive(entry.owner.session) && this.now() - entry.seen < ONLINE_MS;
  }

  private matches(entry: Phone, secret: string) {
    return /^[a-f0-9]{64}$/.test(secret) && timingSafeEqual(Buffer.from(secret), Buffer.from(entry.secret));
  }

  private authorize(id: string, session: string, secret: string) {
    const entry = this.phones.get(PhoneDesk.key(session, id));
    if (!entry || !this.sessionLive(session) || !this.matches(entry, secret)) throw failure("This phone is disconnected or not authorized", 403);
    return entry;
  }

  private finish(job: Job, error: Error | null, result?: unknown) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  private remember(registration: PhoneRegistration, owner: PhoneOwner) {
    const now = this.now();
    const kept = this.remembered.filter((entry) =>
      !(entry.person === owner.person && entry.id === registration.id)
      && this.sessionLive(entry.session) && now - entry.lastSeenAt < RETAIN_MS);
    this.remembered = [...kept, { id: registration.id, name: registration.name, person: owner.person, session: owner.session, can: [...registration.can], lastSeenAt: now }].slice(-PHONES);
    this.save();
  }

  private load(): KnownPhone[] {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) return [];
      return knownFile.parse(JSON.parse(readFileSync(this.file, "utf8"))).phones;
    } catch (error) {
      console.warn(`phone desk: could not read known phones: ${(error as Error).message}`);
      return [];
    }
  }

  private save() {
    if (!this.file) return;
    try { writeFileAtomic(this.file, JSON.stringify({ version: 1, phones: this.remembered }), { mode: 0o600 }); }
    catch (error) { console.warn(`phone desk: could not save known phones: ${(error as Error).message}`); }
  }
}
