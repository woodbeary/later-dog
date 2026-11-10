import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { Notification } from "../notify.ts";
import { replyable } from "../../shared/notification.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;
export const PUSH_LOG_FILE = "phone-push.log";
const MAX_TOKENS = 20;
const LOG_MAX_BYTES = 64 * 1024;
const LOG_KEEP_LINES = 300;
const RECEIPT_DELAY_MS = 60_000;
const TEST_RECEIPT_DELAY_MS = 4_000;
const URGENT = new Set<string>(["approval", "question", "takeover", "phone"]);
export const REPLY_CATEGORY = "reply";

export type PushApp = "later.dog" | "expo-go";

export interface PushStatus {
  registered: boolean;
  app: "later.dog" | "untagged" | null;
}

export interface PushSendReport {
  phones: number;
  accepted: number;
  errors: string[];
}

export interface PhonePush {
  register(token: string, app?: PushApp): boolean;
  unregister(token: string): void;
  tokens(): string[];
  status(token: string): PushStatus;
  send(notification: Notification): Promise<PushSendReport>;
  test(): Promise<PushSendReport>;
}

interface PushTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

export function tokenTail(token: string): string {
  return `…${token.replace(/\]$/, "").slice(-6)}`;
}

function ticketError(ticket: PushTicket | undefined): string | null {
  if (!ticket) return "no answer for this phone";
  if (ticket.status === "ok") return null;
  return [ticket.details?.error, ticket.message].filter(Boolean).join(": ") || "unknown error";
}

export function createPhonePush(options: {
  dataDir: string;
  fetcher?: typeof fetch;
  warn?: (message: string) => void;
  now?: () => Date;
  later?: (run: () => void, ms: number) => void;
  receiptDelayMs?: number;
  testReceiptDelayMs?: number;
}): PhonePush {
  const file = join(options.dataDir, "phone-push.json");
  const logFile = join(options.dataDir, PUSH_LOG_FILE);
  const fetcher = options.fetcher ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const now = options.now ?? (() => new Date());
  const later = options.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  const receiptDelayMs = options.receiptDelayMs ?? RECEIPT_DELAY_MS;
  const testReceiptDelayMs = options.testReceiptDelayMs ?? TEST_RECEIPT_DELAY_MS;
  const log = (line: string) => {
    try {
      appendFileSync(logFile, `${now().toISOString()} ${line.replace(/[\r\n]+/g, " ").slice(0, 1800)}\n`, { mode: 0o600 });
      if (statSync(logFile).size > LOG_MAX_BYTES) {
        const kept = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-LOG_KEEP_LINES);
        while (Buffer.byteLength(`${kept.join("\n")}\n`) > LOG_MAX_BYTES) kept.shift();
        writeFileAtomic(logFile, `${kept.join("\n")}\n`, { mode: 0o600 });
      }
    } catch (error) {
      warn(`[phone-push] could not write ${PUSH_LOG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const problem = (line: string) => {
    log(line);
    warn(`[phone-push] ${line}`);
  };
  const valid = (list: unknown): string[] => Array.isArray(list)
    ? list.filter((token): token is string => typeof token === "string" && EXPO_PUSH_TOKEN.test(token)) : [];
  const load = (): { tokens: string[]; native: string[] } => {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { tokens?: unknown; native?: unknown };
      return { tokens: valid(saved.tokens), native: valid(saved.native) };
    } catch {
      return { tokens: [], native: [] };
    }
  };
  const read = (): string[] => load().tokens;
  const write = (tokens: string[], native = load().native) => {
    const kept = native.filter((token) => tokens.includes(token));
    writeFileAtomic(file, `${JSON.stringify(kept.length ? { tokens, native: kept } : { tokens })}\n`, { mode: 0o600 });
  };
  const forget = (gone: string[], why: string) => {
    if (!gone.length) return;
    write(read().filter((token) => !gone.includes(token)));
    log(`forgot ${gone.map(tokenTail).join(", ")}: ${why}`);
  };

  const checkReceipts = async (ids: Map<string, string>): Promise<string[]> => {
    if (!ids.size) return [];
    let answer: { data?: Record<string, PushTicket> } | null;
    try {
      const response = await fetcher(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ids: [...ids.keys()] }),
      });
      answer = (await response.json().catch(() => null)) as typeof answer;
      if (!response.ok || !answer?.data) {
        const error = `receipts: the push service answered ${response.status}`;
        problem(error);
        return [error];
      }
    } catch (error) {
      const why = `receipts: could not reach the push service: ${error instanceof Error ? error.message : String(error)}`;
      problem(why);
      return [why];
    }
    const errors: string[] = [];
    const gone: string[] = [];
    for (const [id, token] of ids) {
      const receipt = answer.data[id];
      if (!receipt) continue;
      const error = ticketError(receipt);
      if (!error) continue;
      errors.push(`${tokenTail(token)} ${error}`);
      problem(`receipt for ${tokenTail(token)}: ${error}`);
      if (receipt.details?.error === "DeviceNotRegistered") gone.push(token);
    }
    forget(gone, "Apple says the app is no longer on that phone");
    return errors;
  };

  const deliver = async (
    tokens: string[],
    message: (to: string) => Record<string, unknown>,
    label: string,
    receipts: "later" | "wait",
  ): Promise<PushSendReport> => {
    let response: Response;
    try {
      response = await fetcher(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(tokens.map(message)),
      });
    } catch (error) {
      const why = `could not reach the push service: ${error instanceof Error ? error.message : String(error)}`;
      problem(`${label}: ${why}`);
      return { phones: tokens.length, accepted: 0, errors: [why] };
    }
    const answer = (await response.json().catch(() => null)) as { data?: PushTicket[] } | null;
    if (!response.ok || !Array.isArray(answer?.data)) {
      const why = `the push service answered ${response.status}`;
      problem(`${label}: ${why}`);
      return { phones: tokens.length, accepted: 0, errors: [why] };
    }
    const errors: string[] = [];
    const ids = new Map<string, string>();
    const gone: string[] = [];
    tokens.forEach((token, index) => {
      const ticket = answer.data?.[index];
      const error = ticketError(ticket);
      if (error) {
        errors.push(`${tokenTail(token)} ${error}`);
        problem(`${label} to ${tokenTail(token)}: ${error}`);
        if (ticket?.details?.error === "DeviceNotRegistered") gone.push(token);
      } else if (ticket?.id) ids.set(ticket.id, token);
    });
    forget(gone, "Apple says the app is no longer on that phone");
    if (ids.size) log(`${label}: accepted for ${[...ids.values()].map(tokenTail).join(", ")}`);
    const report = { phones: tokens.length, accepted: ids.size, errors };
    if (receipts === "wait") {
      await new Promise<void>((resolve) => later(resolve, testReceiptDelayMs));
      const late = await checkReceipts(ids);
      return { ...report, accepted: Math.max(0, ids.size - late.length), errors: [...errors, ...late] };
    }
    later(() => void checkReceipts(ids), receiptDelayMs);
    return report;
  };

  return {
    register(token, app) {
      if (!EXPO_PUSH_TOKEN.test(token)) {
        log("register refused: not an Expo push token");
        return false;
      }
      const { tokens, native } = load();
      const others = tokens.filter((known) => known !== token);
      if (app === "expo-go") {
        if (others.length !== tokens.length) write(others, native);
        log(`register ${tokenTail(token)} from Expo Go: not kept`);
        return false;
      }
      if (app !== "later.dog") {
        if (native.length) {
          log(`register ${tokenTail(token)} without an app name: not kept, the later.dog app is registered`);
          return false;
        }
        write([...others, token].slice(-MAX_TOKENS), native);
        log(`register ${tokenTail(token)} without an app name: kept`);
        return true;
      }
      const confirmed = [...native.filter((known) => known !== token), token];
      const dropped = others.filter((known) => !confirmed.includes(known));
      write([...others.filter((known) => confirmed.includes(known)), token].slice(-MAX_TOKENS), confirmed);
      log(`register ${tokenTail(token)} from later.dog: kept${dropped.length ? `; stopped sending to ${dropped.map(tokenTail).join(", ")}` : ""}`);
      return true;
    },
    unregister(token) {
      const tokens = read();
      if (tokens.includes(token)) write(tokens.filter((known) => known !== token));
      log(`unregister ${tokenTail(token)}`);
    },
    tokens: read,
    status(token) {
      const { tokens, native } = load();
      if (!tokens.includes(token)) return { registered: false, app: null };
      return { registered: true, app: native.includes(token) ? "later.dog" : "untagged" };
    },
    async send(notification) {
      const tokens = read();
      if (!tokens.length) return { phones: 0, accepted: 0, errors: [] };
      const urgent = URGENT.has(notification.kind);
      return deliver(tokens, (to) => ({
        to,
        title: notification.title,
        body: notification.body,
        sound: "default",
        data: { kind: notification.kind, botId: notification.botId, threadId: notification.threadId },
        ...(urgent ? { priority: "high", interruptionLevel: "time-sensitive" } : {}),
        ...(notification.botId && notification.threadId && replyable(notification.kind) ? { categoryId: REPLY_CATEGORY } : {}),
      }), `ping (${notification.kind})`, "later");
    },
    async test() {
      const tokens = read();
      if (!tokens.length) {
        log("test ping: no phone is registered");
        return { phones: 0, accepted: 0, errors: ["No phone is registered for pings."] };
      }
      return deliver(tokens, (to) => ({
        to,
        title: "Test ping",
        body: "Pings from your dogs reach this phone.",
        sound: "default",
        data: { kind: "test" },
      }), "test ping", "wait");
    },
  };
}

export const PHONE_PUSH_TEST_PATH = "/api/phone/push/test";

export async function phonePushRequest(
  method: string,
  readBody: () => Promise<unknown>,
  push: PhonePush,
  url?: URL,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (method === "GET") {
    const token = url?.searchParams.get("token") ?? "";
    if (!EXPO_PUSH_TOKEN.test(token)) return { status: 400, body: { error: "token must be an Expo push token" } };
    return { status: 200, body: { ...push.status(token) } };
  }
  if (method !== "POST" && method !== "DELETE") return { status: 405, body: { error: "method not allowed" } };
  const body = await readBody();
  const token = body && typeof body === "object" && "token" in body ? (body as { token: unknown }).token : undefined;
  if (typeof token !== "string" || !EXPO_PUSH_TOKEN.test(token)) return { status: 400, body: { error: "token must be an Expo push token" } };
  const app = body && typeof body === "object" && "app" in body ? (body as { app: unknown }).app : undefined;
  if (method === "DELETE") {
    push.unregister(token);
    return { status: 200, body: { ok: true } };
  }
  push.register(token, app === "later.dog" || app === "expo-go" ? app : undefined);
  return { status: 200, body: { ok: true, ...push.status(token) } };
}
