export const ADMIT_PATH = "/api/internal/coordinator/admit";
export const ADMISSION_PATH = "/api/internal/coordinator/admission";
export const ADMISSION_DOG = "home";
export const ARRIVAL_LEASE_MS = 30_000;
export const MAX_ARRIVALS = 5_000;
export const MAX_SEND_BODY_BYTES = 64 * 1024;
const ID = /^[\w-]{1,128}$/;
const SEND_ID = /^[A-Za-z0-9_-]{16,80}$/;
const SEND_KEYS = new Set(["text", "threadId", "sendId", "replyToId", "deliver"]);

export interface AdmissionSession {
  hash: string;
  id: string;
  scopes: string[];
  expiresAt: number;
}

export interface AdmissionConfig {
  sessions: AdmissionSession[];
  dogs: string[];
}

export interface Arrival {
  id: string;
  dog: string;
  chat: string;
  session: string;
  body: Record<string, unknown>;
  at: number;
}

export type AdmitOutcome = { ok: true; id: string; duplicate: boolean } | { ok: false; why: string };

export interface AdmissionPort {
  configure(config: AdmissionConfig): Promise<number>;
  admit(input: { hash: string; dog: string; chat: string; body: Record<string, unknown> }): Promise<AdmitOutcome>;
  take(limit: number): Promise<Arrival[]>;
  done(ids: string[]): Promise<number>;
}

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

interface KeyStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export function validConfig(value: unknown): value is AdmissionConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return Array.isArray(config.dogs) && config.dogs.every((dog) => typeof dog === "string" && (dog === "*" || ID.test(dog))) &&
    Array.isArray(config.sessions) && config.sessions.length <= 10_000 && config.sessions.every((session) => {
      const s = session as Record<string, unknown>;
      return typeof s.hash === "string" && /^[0-9a-f]{64}$/.test(s.hash) && typeof s.id === "string" && s.id.length <= 128 &&
        Array.isArray(s.scopes) && s.scopes.every((scope) => typeof scope === "string") && typeof s.expiresAt === "number";
    });
}

export function plainSend(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const send = body as Record<string, unknown>;
  if (Object.keys(send).some((key) => !SEND_KEYS.has(key))) return null;
  if (typeof send.text !== "string" || !send.text.trim() || send.text.length > 32_000) return null;
  if (typeof send.threadId !== "string" || !ID.test(send.threadId)) return null;
  if (typeof send.sendId !== "string" || !SEND_ID.test(send.sendId)) return null;
  if (send.replyToId !== undefined && (typeof send.replyToId !== "string" || !ID.test(send.replyToId))) return null;
  if (send.deliver !== undefined && send.deliver !== "steer" && send.deliver !== "queue") return null;
  return send;
}

export function homeAdmission(sql: Sql, storage: KeyStorage, now: () => number = Date.now): AdmissionPort {
  sql.exec(`CREATE TABLE IF NOT EXISTS arrivals (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    dog TEXT NOT NULL,
    chat TEXT NOT NULL,
    session TEXT NOT NULL,
    body TEXT NOT NULL,
    at INTEGER NOT NULL,
    lease INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0
  )`);
  let config: AdmissionConfig | null = null;
  const current = async () => (config ??= (await storage.get<AdmissionConfig>("admission")) ?? { sessions: [], dogs: [] });
  return {
    async configure(next) {
      config = next;
      await storage.put("admission", next);
      return next.sessions.length;
    },
    async admit({ hash, dog, chat, body }) {
      const { sessions, dogs } = await current();
      if (!dogs.includes("*") && !dogs.includes(dog)) return { ok: false, why: "dog_not_on_edge" };
      const session = sessions.find((candidate) => candidate.hash === hash);
      if (!session || session.expiresAt <= now()) return { ok: false, why: "unknown_session" };
      if (!session.scopes.includes("admin")) return { ok: false, why: "not_owner" };
      const send = plainSend(body);
      if (!send || send.threadId !== chat) return { ok: false, why: "not_plain" };
      const id = `e-${send.sendId as string}`;
      if (sql.exec("SELECT 1 FROM arrivals WHERE id = ?", id).toArray().length) return { ok: true, id, duplicate: true };
      const waiting = Number(sql.exec("SELECT COUNT(*) AS n FROM arrivals WHERE done = 0").toArray()[0]?.n ?? 0);
      if (waiting >= MAX_ARRIVALS) return { ok: false, why: "full" };
      sql.exec("INSERT INTO arrivals (id, dog, chat, session, body, at) VALUES (?, ?, ?, ?, ?, ?)", id, dog, chat, session.id, JSON.stringify(send), now());
      return { ok: true, id, duplicate: false };
    },
    async take(limit) {
      const at = now();
      const rows = sql.exec("SELECT id, dog, chat, session, body, at FROM arrivals WHERE done = 0 AND lease <= ? ORDER BY seq LIMIT ?", at, Math.max(1, Math.min(200, limit))).toArray();
      for (const row of rows) sql.exec("UPDATE arrivals SET lease = ? WHERE id = ?", at + ARRIVAL_LEASE_MS, row.id);
      sql.exec("DELETE FROM arrivals WHERE done = 1 AND at < ?", at - 24 * 60 * 60_000);
      return rows.map((row) => ({ id: String(row.id), dog: String(row.dog), chat: String(row.chat), session: String(row.session), body: JSON.parse(String(row.body)) as Record<string, unknown>, at: Number(row.at) }));
    },
    async done(ids) {
      let count = 0;
      for (const id of ids) {
        if (typeof id !== "string" || id.length > 160) continue;
        sql.exec("UPDATE arrivals SET done = 1 WHERE id = ?", id);
        count += 1;
      }
      return count;
    },
  };
}

export function admissionReceipt(outcome: { id: string }, chat: string): Response {
  return Response.json({ ok: true, queued: true, queueId: outcome.id, threadId: chat, admitted: "edge" }, { status: 202, headers: { "cache-control": "no-store" } });
}

const SEND_PATH = /^\/api\/bots\/([\w-]+)\/messages$/;

export function sendTarget(request: Request): string | null {
  if (request.method !== "POST") return null;
  return SEND_PATH.exec(new URL(request.url).pathname)?.[1] ?? null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface EdgeAdmissionDeps {
  enabled: boolean;
  home: string;
  coordinator: Pick<Fetcher, "fetch"> | undefined;
  claimsHeader: string;
  now?: () => number;
}

export async function admitAtEdge(request: Request, deps: EdgeAdmissionDeps): Promise<Response | null> {
  if (!deps.enabled || !deps.coordinator) return null;
  const dog = sendTarget(request);
  if (!dog) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!bearer || !bearer.startsWith("laterdog_sess_")) return null;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_SEND_BODY_BYTES) return null;
  const raw = await request.clone().text().catch(() => null);
  if (raw === null || raw.length > MAX_SEND_BODY_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const send = plainSend(body);
  if (!send) return null;
  const at = (deps.now ?? Date.now)();
  const claims = { home: deps.home, dog, chat: send.threadId as string, generation: "edge", kind: "turns", issuedAt: at, expiresAt: at + 60_000 };
  try {
    const answer = await deps.coordinator.fetch(new Request(`https://coordinator${ADMIT_PATH}`, {
      method: "POST",
      headers: { [deps.claimsHeader]: JSON.stringify(claims), "content-type": "application/json" },
      body: JSON.stringify({ hash: await sha256Hex(bearer), body: send }),
    }));
    if (answer.status !== 202) return null;
    const outcome = (await answer.json()) as { id?: unknown };
    return typeof outcome.id === "string" ? admissionReceipt({ id: outcome.id }, send.threadId as string) : null;
  } catch {
    return null;
  }
}
