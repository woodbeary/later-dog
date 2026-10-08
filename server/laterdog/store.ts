import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { activeJob, repositorySchema, type BackendId, type CreateJob, type Job, type JobEvent, type Repository, type Wakeup, type WakeupSettlement } from "../../shared/laterdog.ts";

export class WorkspaceStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (slug TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, roots TEXT NOT NULL, last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bridge_requests (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, roots TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (request_key TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, document TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    `);
    if (file !== ":memory:") chmodSync(file, 0o600);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  jobs(): Job[] {
    return (this.db.prepare("SELECT document FROM jobs ORDER BY rowid DESC").all() as { document: string }[]).map((row) => JSON.parse(row.document) as Job);
  }
  job(id: string): Job {
    const row = this.db.prepare("SELECT document FROM jobs WHERE id=?").get(id) as { document: string } | undefined;
    if (!row) throw Object.assign(new Error("Job not found"), { status: 404 });
    return JSON.parse(row.document) as Job;
  }
  create(input: CreateJob, backend: BackendId = "codex-cloud"): Job {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT document FROM jobs WHERE request_key=?").get(input.requestKey) as { document: string } | undefined;
      if (existing) {
        const job = JSON.parse(existing.document) as Job;
        const keys = Object.keys(input) as (keyof CreateJob)[];
        if (keys.some((key) => JSON.stringify(job[key]) !== JSON.stringify(input[key]))) throw Object.assign(new Error("requestKey already belongs to a different request"), { status: 409 });
        return job;
      }
      this.repository(input.repository);
      for (const dependency of input.dependencies) this.job(dependency);
      const parent = input.parentId ? this.job(input.parentId) : undefined;
      if (parent && parent.repository !== input.repository) throw new Error("A correction must use its parent's repository");
      const id = randomUUID(); const now = new Date().toISOString();
      const job: Job = { ...input, id, state: "queued", backend, attempt: parent ? parent.attempt + 1 : 1,
        createdAt: now, updatedAt: now, outputBranch: input.kind === "repair" && parent ? parent.outputBranch : `laterdog/${id}`,
        ...(input.kind === "repair" && parent?.prUrl ? { prUrl: parent.prUrl, prNumber: parent.prNumber } : {}) };
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?)").run(id, input.requestKey, JSON.stringify(job));
      this.event(id, "created", input.kind === "repair" ? "New repair run; native cloud continuation is unavailable" : input.title);
      return job;
    });
  }
  update(id: string, patch: Partial<Job>, type = "updated", detail = ""): Job {
    return this.transaction(() => {
      const job = { ...this.job(id), ...patch, updatedAt: new Date().toISOString() };
      this.db.prepare("UPDATE jobs SET document=? WHERE id=?").run(JSON.stringify(job), id);
      this.event(id, type, detail || job.state);
      return job;
    });
  }
  event(id: string, type: string, detail: string): void {
    const event = this.db.prepare("INSERT INTO events(job_id,at,type,detail) VALUES(?,?,?,?)").run(id, new Date().toISOString(), type, detail.slice(0,10_000));
    if (["collected","published","verified","reviewed","provider_failed","preparation_blocked","publication_blocked","submission_unknown","merged","collection_blocked"].includes(type)) {
      const job = this.job(id);
      if (job.botId && job.conversationId) this.db.prepare("INSERT INTO outbox(id,job_id,document) VALUES(?,?,?)").run(Number(event.lastInsertRowid),id,
        JSON.stringify({ botId: job.botId, threadId: job.conversationId, sendId: `laterdog_${id.replaceAll("-","")}_${event.lastInsertRowid}`,
          text: `later.dog job ${id}: ${type}. ${detail}\nState: ${job.state}. ${job.prUrl ?? job.taskUrl ?? ""}\n${job.blocker ?? ""}\nInspect this job through laterdog tools, then decide the next useful action under the standing repository authority. Cloud completion alone is not verification.` }));
    }
  }
  events(id: string): JobEvent[] {
    return this.db.prepare("SELECT sequence,job_id AS jobId,at,type,detail FROM events WHERE job_id=? ORDER BY sequence DESC LIMIT 200").all(id) as unknown as JobEvent[];
  }
  repositories(): Repository[] {
    return (this.db.prepare("SELECT document FROM repositories ORDER BY slug").all() as { document: string }[]).map((row) => repositorySchema.parse(JSON.parse(row.document)));
  }
  repository(slug: string): Repository {
    const row = this.db.prepare("SELECT document FROM repositories WHERE slug=?").get(slug) as { document: string } | undefined;
    if (!row) throw Object.assign(new Error("Configure this repository and its Codex Cloud environment first"), { status: 409 });
    return repositorySchema.parse(JSON.parse(row.document));
  }
  saveRepository(repo: Repository): void {
    if (this.jobs().some((job) => job.repository === repo.slug && activeJob(job))) throw Object.assign(new Error("Wait for active jobs before changing repository policy"), { status: 409 });
    this.db.prepare("INSERT INTO repositories VALUES(?,?) ON CONFLICT(slug) DO UPDATE SET document=excluded.document").run(repo.slug, JSON.stringify(repo));
  }
  /** Wake-ups still waiting for these dogs' conversations, oldest first. A desktop pulls them when the supervisor cannot call it (hosted). */
  pendingWakeups(bots: ReadonlySet<string>, limit = 20): Wakeup[] {
    const wakeups: Wakeup[] = [];
    for (const row of this.db.prepare("SELECT id,document FROM outbox WHERE delivered=0 ORDER BY id").all() as { id: number; document: string }[]) {
      const wakeup = { id: row.id, ...JSON.parse(row.document) } as Wakeup;
      if (bots.has(wakeup.botId)) wakeups.push(wakeup);
      if (wakeups.length >= limit) break;
    }
    return wakeups;
  }
  /** The dogs with a wake-up still waiting: the hosted Worker answers a desktop's pull itself, without waking the container, when none is its. */
  wakeupBots(): string[] {
    const rows = this.db.prepare("SELECT document FROM outbox WHERE delivered=0").all() as { document: string }[];
    return [...new Set(rows.map((row) => (JSON.parse(row.document) as Wakeup).botId))].sort();
  }
  /** 1 = handed to the conversation, 2 = dropped (the reason is recorded on the job). False when it was already settled, so a retry is harmless. */
  settleWakeup(id: number, settlement: WakeupSettlement): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT job_id AS jobId FROM outbox WHERE id=? AND delivered=0").get(id) as { jobId: string } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE outbox SET delivered=? WHERE id=?").run(settlement.outcome === "delivered" ? 1 : 2, id);
      if (settlement.outcome === "dropped") this.event(row.jobId, "wakeup_dropped", settlement.reason);
      return true;
    });
  }
  lease(owner: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT owner,expires FROM supervisor WHERE id=1").get() as { owner: string; expires: number } | undefined;
      if (row && row.owner !== owner && row.expires > now) return false;
      this.db.prepare("INSERT INTO supervisor VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires").run(owner, now + 60_000);
      return true;
    });
  }
  release(owner: string): void { this.db.prepare("DELETE FROM supervisor WHERE owner=?").run(owner); }
  close(): void { this.db.close(); }
}
