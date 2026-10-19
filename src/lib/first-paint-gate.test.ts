import { describe, expect, it, vi } from "vitest";

import { answerWithin, paintedBeforeSession, signInReason } from "./first-paint-gate";
import type { SessionState } from "./session";

const SERVICE = "service reason";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gate(hasSnapshot: boolean, session: Promise<SessionState>, ready: Promise<unknown> = Promise.resolve()) {
  const painted: string[] = [];
  const forget = vi.fn();
  const done = paintedBeforeSession({
    hasSnapshot,
    ready,
    session,
    waitMs: 10,
    paint: (root: string) => painted.push(root),
    app: () => "app",
    signIn: (reason) => `sign-in:${reason}`,
    forget,
    serviceReason: SERVICE,
  });
  return { painted, forget, done };
}

describe("answerWithin", () => {
  it("answers with the value in time, and not at all for slow or failed work", async () => {
    await expect(answerWithin(Promise.resolve(3), 10)).resolves.toEqual({ answered: true, value: 3 });
    await expect(answerWithin(new Promise(() => {}), 5)).resolves.toEqual({ answered: false });
    await expect(answerWithin(Promise.reject(new Error("no")), 10)).resolves.toEqual({ answered: false });
  });
});

describe("signInReason", () => {
  it("asks to sign in only for a refused or service session", () => {
    expect(signInReason({ kind: "unauthenticated", error: "expired" }, SERVICE)).toEqual({ reason: "expired" });
    expect(signInReason({ kind: "loopback", trust: "service" }, SERVICE)).toEqual({ reason: SERVICE });
    expect(signInReason({ kind: "loopback" }, SERVICE)).toBeNull();
    expect(signInReason({ kind: "unreachable", error: "down" }, SERVICE)).toBeNull();
    expect(signInReason({ kind: "session", id: "s", label: "", scopes: [], expiresAt: 0 }, SERVICE)).toBeNull();
  });
});

describe("painting before the session answers", () => {
  it("leaves everything to the normal path without a saved copy, however slow the session", async () => {
    const run = gate(false, new Promise(() => {}));
    await expect(run.done).resolves.toBe(false);
    expect(run.painted).toEqual([]);
  });

  it("leaves everything to the normal path when the session answers in time", async () => {
    const run = gate(true, Promise.resolve({ kind: "unauthenticated", error: "expired" }));
    await expect(run.done).resolves.toBe(false);
    expect(run.painted).toEqual([]);
    expect(run.forget).not.toHaveBeenCalled();
  });

  it("paints the app from the saved copy while a stalled session never answers", async () => {
    const run = gate(true, new Promise(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(run.painted).toEqual(["app"]);
    expect(run.forget).not.toHaveBeenCalled();
  });

  it("does not wait on a stalled brand either", async () => {
    const run = gate(true, Promise.resolve({ kind: "loopback" }), new Promise(() => {}));
    await expect(run.done).resolves.toBe(true);
    expect(run.painted).toEqual(["app"]);
  });

  it("keeps the app when the late session is the owner", async () => {
    const session = deferred<SessionState>();
    const run = gate(true, session.promise);
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.resolve({ kind: "loopback" });
    await expect(run.done).resolves.toBe(true);
    expect(run.painted).toEqual(["app"]);
    expect(run.forget).not.toHaveBeenCalled();
  });

  it("forgets the saved copy and asks to sign in when the late session is refused or a service", async () => {
    for (const [late, reason] of [[{ kind: "unauthenticated", error: "expired" }, "expired"], [{ kind: "loopback", trust: "service" }, SERVICE]] as const) {
      const session = deferred<SessionState>();
      const run = gate(true, session.promise);
      await new Promise((resolve) => setTimeout(resolve, 30));
      session.resolve(late);
      await expect(run.done).resolves.toBe(true);
      expect(run.painted).toEqual(["app", `sign-in:${reason}`]);
      expect(run.forget).toHaveBeenCalledTimes(1);
    }
  });
});
