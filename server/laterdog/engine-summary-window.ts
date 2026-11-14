export type SummaryRefusal = "not-compacting" | "already-received" | "other-session";

interface Window {
  sessionId: string | undefined;
  used: boolean;
}

export interface EngineSummaryWindows {
  sessionStarted(threadId: string, sessionId: string): void;
  compacting(threadId: string): void;
  turnEnded(threadId: string): void;
  accept(threadId: string, sessionId: unknown): SummaryRefusal | null;
}

export function createEngineSummaryWindows(): EngineSummaryWindows {
  const sessions = new Map<string, string>();
  const open = new Map<string, Window>();
  return {
    sessionStarted: (threadId, sessionId) => { sessions.set(threadId, sessionId); },
    compacting: (threadId) => { open.set(threadId, { sessionId: sessions.get(threadId), used: false }); },
    turnEnded: (threadId) => { open.delete(threadId); },
    accept: (threadId, sessionId) => {
      const window = open.get(threadId);
      if (!window) return "not-compacting";
      if (window.used) return "already-received";
      if (!window.sessionId || sessionId !== window.sessionId) return "other-session";
      window.used = true;
      return null;
    },
  };
}
