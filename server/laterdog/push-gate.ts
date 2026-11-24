import type { Notification } from "../../shared/notification.ts";

export const APPROVAL_REPEAT_MS = 30 * 60_000;
export const PROMPT_REPEAT_MS = 10 * 60_000;
export const PROMPT_GATHER_MS = 5_000;

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function createPushGate(options: {
  now?: () => number;
  later?: (run: () => void, ms: number) => void;
  gatherMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const later = options.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  const gatherMs = options.gatherMs ?? PROMPT_GATHER_MS;
  const seen = new Map<string, number>();
  const gathering = new Map<string, { first: Notification; names: string[] }>();

  const fresh = (key: string, ttl: number): boolean => {
    const at = seen.get(key);
    if (at !== undefined && now() - at < ttl) return false;
    seen.set(key, now());
    if (seen.size > 500) for (const [k, t] of seen) if (now() - t > APPROVAL_REPEAT_MS) seen.delete(k);
    return true;
  };

  return (notification: Notification, emit: (notification: Notification) => void): void => {
    if (notification.kind === "approval") {
      const key = `approval|${notification.botId}|${notification.requestId ?? `${notification.threadId}|${notification.body}`}`;
      if (fresh(key, APPROVAL_REPEAT_MS)) emit(notification);
      return;
    }
    const prompt = notification.promptKey;
    if (notification.kind !== "takeover" || !prompt) {
      emit(notification);
      return;
    }
    const open = gathering.get(prompt);
    if (open) {
      if (!open.names.includes(notification.botName)) open.names.push(notification.botName);
      return;
    }
    if (!fresh(`prompt|${prompt}`, PROMPT_REPEAT_MS)) return;
    const batch = { first: notification, names: [notification.botName] };
    gathering.set(prompt, batch);
    later(() => {
      gathering.delete(prompt);
      const { first, names } = batch;
      if (names.length === 1) {
        emit(first);
        return;
      }
      emit({ ...first, title: `${joinNames(names)} need your hands`, body: `${first.body} ${joinNames(names)} are waiting on it.` });
    }, gatherMs);
  };
}

const HELPER_QUIET_KINDS: ReadonlySet<Notification["kind"]> = new Set(["done", "delegation-settled", "turn-failed", "incident", "routine-failed", "routine-deferred"]);

export function pushWorthy(notification: Notification, state: { fullAccess: boolean; helper: boolean }): boolean {
  if (notification.kind === "approval" && !notification.mustAsk && state.fullAccess) return false;
  if (state.helper && HELPER_QUIET_KINDS.has(notification.kind)) return false;
  return true;
}
