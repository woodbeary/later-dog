export const RECENT_USE_MS = 24 * 60 * 60_000;
export const WORKING_DAY_MS = 10 * 60 * 60_000;
export const WARM_ENGINES_PER_COMPUTER = 3;

export interface KeepWarm {
  personAsked(botId: string, threadId: string, at?: number): void;
  idleMs(threadId: string, fallbackMs: number, now?: number): number;
  forget(threadId: string): void;
}

export function createKeepWarm(options: { perComputer?: number; workingDayMs?: number; recentMs?: number } = {}): KeepWarm {
  const perComputer = options.perComputer ?? WARM_ENGINES_PER_COMPUTER;
  const workingDayMs = options.workingDayMs ?? WORKING_DAY_MS;
  const recentMs = options.recentMs ?? RECENT_USE_MS;
  const chats = new Map<string, { botId: string; at: number }>();
  return {
    personAsked(botId, threadId, at = Date.now()) {
      chats.set(threadId, { botId, at });
    },
    idleMs(threadId, fallbackMs, now = Date.now()) {
      const chat = chats.get(threadId);
      if (!chat || now - chat.at > recentMs) return fallbackMs;
      const newer = [...chats.values()].filter((other) => other.botId === chat.botId && other.at > chat.at && now - other.at <= recentMs).length;
      if (newer >= perComputer) return fallbackMs;
      return Math.max(fallbackMs, chat.at + workingDayMs - now);
    },
    forget(threadId) {
      chats.delete(threadId);
    },
  };
}

export const keepWarm = createKeepWarm();
