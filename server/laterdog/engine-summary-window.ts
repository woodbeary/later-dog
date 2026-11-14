export type SummaryRefusal = "not-compacting" | "other-session";

export const SUMMARY_GRACE_AFTER_COMPACTED_MS = 10_000;

interface Window {
  sessionId: string | undefined;
  closesAt: number | undefined;
}

export interface EngineSummaryWindows {
  sessionStarted(threadId: string, sessionId: string): void;
  compacting(threadId: string): void;
  compacted(threadId: string): void;
  turnEnded(threadId: string): void;
  accept(threadId: string, sessionId: unknown): SummaryRefusal | null;
}

export function createEngineSummaryWindows(now: () => number = Date.now): EngineSummaryWindows {
  const sessions = new Map<string, string>();
  const open = new Map<string, Window>();
  return {
    sessionStarted: (threadId, sessionId) => { sessions.set(threadId, sessionId); },
    compacting: (threadId) => { open.set(threadId, { sessionId: sessions.get(threadId), closesAt: undefined }); },
    compacted: (threadId) => {
      const window = open.get(threadId);
      if (window && window.closesAt === undefined) window.closesAt = now() + SUMMARY_GRACE_AFTER_COMPACTED_MS;
    },
    turnEnded: (threadId) => { open.delete(threadId); },
    accept: (threadId, sessionId) => {
      const window = open.get(threadId);
      if (!window) return "not-compacting";
      if (window.closesAt !== undefined && now() > window.closesAt) {
        open.delete(threadId);
        return "not-compacting";
      }
      if (!window.sessionId || sessionId !== window.sessionId) return "other-session";
      return null;
    },
  };
}
