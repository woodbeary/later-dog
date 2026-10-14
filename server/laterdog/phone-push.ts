import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { Notification } from "../notify.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;
const MAX_TOKENS = 20;
const URGENT = new Set<string>(["approval", "question", "takeover"]);
const NOT_REPLYABLE = new Set<string>(["approval", "takeover"]);
export const REPLY_CATEGORY = "reply";

export interface PhonePush {
  register(token: string): boolean;
  unregister(token: string): void;
  tokens(): string[];
  send(notification: Notification): Promise<void>;
}

interface PushTicket {
  status?: string;
  details?: { error?: string };
}

export function createPhonePush(options: { dataDir: string; fetcher?: typeof fetch; warn?: (message: string) => void }): PhonePush {
  const file = join(options.dataDir, "phone-push.json");
  const fetcher = options.fetcher ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const read = (): string[] => {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { tokens?: unknown };
      return Array.isArray(saved.tokens) ? saved.tokens.filter((token): token is string => typeof token === "string" && EXPO_PUSH_TOKEN.test(token)) : [];
    } catch {
      return [];
    }
  };
  const write = (tokens: string[]) => writeFileAtomic(file, `${JSON.stringify({ tokens })}\n`, { mode: 0o600 });

  return {
    register(token) {
      if (!EXPO_PUSH_TOKEN.test(token)) return false;
      write([...read().filter((known) => known !== token), token].slice(-MAX_TOKENS));
      return true;
    },
    unregister(token) {
      const tokens = read();
      if (tokens.includes(token)) write(tokens.filter((known) => known !== token));
    },
    tokens: read,
    async send(notification) {
      const tokens = read();
      if (!tokens.length) return;
      const urgent = URGENT.has(notification.kind);
      const messages = tokens.map((to) => ({
        to,
        title: notification.title,
        body: notification.body,
        sound: "default",
        data: { kind: notification.kind, botId: notification.botId, threadId: notification.threadId },
        ...(urgent ? { priority: "high", interruptionLevel: "time-sensitive" } : {}),
        ...(notification.botId && notification.threadId && !NOT_REPLYABLE.has(notification.kind) ? { categoryId: REPLY_CATEGORY } : {}),
      }));
      let response: Response;
      try {
        response = await fetcher(EXPO_PUSH_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(messages),
        });
      } catch (error) {
        warn(`[phone-push] could not reach the push service: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const answer = (await response.json().catch(() => null)) as { data?: PushTicket[] } | null;
      if (!response.ok || !Array.isArray(answer?.data)) {
        warn(`[phone-push] the push service answered ${response.status}`);
        return;
      }
      const gone = tokens.filter((_, index) => answer.data?.[index]?.details?.error === "DeviceNotRegistered");
      if (gone.length) write(read().filter((token) => !gone.includes(token)));
    },
  };
}

export async function phonePushRequest(
  method: string,
  readBody: () => Promise<unknown>,
  push: PhonePush,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (method !== "POST" && method !== "DELETE") return { status: 405, body: { error: "method not allowed" } };
  const body = await readBody();
  const token = body && typeof body === "object" && "token" in body ? (body as { token: unknown }).token : undefined;
  if (typeof token !== "string" || !EXPO_PUSH_TOKEN.test(token)) return { status: 400, body: { error: "token must be an Expo push token" } };
  if (method === "POST") push.register(token);
  else push.unregister(token);
  return { status: 200, body: { ok: true } };
}
