import type { SessionState } from "./session";

export const FIRST_PAINT_SESSION_WAIT_MS = 300;

export type Answer<T> = { answered: true; value: T } | { answered: false };

export function answerWithin<T>(work: Promise<T>, waitMs: number): Promise<Answer<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ answered: false }), waitMs);
    work.then(
      (value) => { clearTimeout(timer); resolve({ answered: true, value }); },
      () => { clearTimeout(timer); resolve({ answered: false }); },
    );
  });
}

export type SignInReason = { reason: string } | null;

export function signInReason(session: SessionState, serviceReason: string): SignInReason {
  if (session.kind === "unauthenticated") return { reason: session.error };
  if (session.kind === "loopback" && session.trust === "service") return { reason: serviceReason };
  return null;
}

export interface FirstPaintGateOptions<Root> {
  hasSnapshot: boolean;
  ready: Promise<unknown>;
  session: Promise<SessionState>;
  waitMs?: number;
  paint: (root: Root) => void;
  app: () => Root;
  signIn: (reason: string) => Root;
  forget: () => void;
  serviceReason: string;
}

export async function paintedBeforeSession<Root>(options: FirstPaintGateOptions<Root>): Promise<boolean> {
  const { hasSnapshot, ready, session, waitMs = FIRST_PAINT_SESSION_WAIT_MS, paint, app, signIn, forget, serviceReason } = options;
  if (!hasSnapshot) return false;
  const early = await answerWithin(Promise.all([ready, session]), waitMs);
  if (early.answered) return false;
  paint(app());
  const needed = signInReason(await session, serviceReason);
  if (needed) {
    forget();
    paint(signIn(needed.reason));
  }
  return true;
}
