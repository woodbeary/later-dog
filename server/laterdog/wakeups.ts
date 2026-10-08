// Wake-ups from a hosted supervisor. When a dog's cloud job moves (collected, published, verified, blocked…) the supervisor
// queues one message for the conversation that delegated it. The local supervisor calls this desktop with it
// (LATERDOG_WORKSPACE_URL); a hosted one (Cloudflare) cannot reach this machine, so the desktop asks for its dogs' wake-ups
// instead and hands each to its conversation the way a typed message arrives. The supervisor keeps each one until it is
// settled, so a Mac that slept through a job still wakes the conversation when it is back; the send id makes a repeat harmless.
import type { Wakeup, WakeupSettlement } from "../../shared/laterdog.ts";
import { desktopSupervisorToken, supervisorConnection } from "./config.ts";

export interface WakeupPullOptions {
  /** Every dog on this desktop; only their wake-ups are asked for. */
  bots(): string[];
  /** Hands one wake-up to its conversation (the direct-send path). Throws with `status` (and `body.code`) when refused. */
  send(wakeup: Wakeup): Promise<unknown>;
  /** Milliseconds between pulls; `LATERDOG_WAKEUP_PULL_MS`, default 30 s; 0 turns pulling off. */
  intervalMs?: number;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}
export interface WakeupPull { pull(): Promise<number>; stop(): void }

let pulling = false;
/** Whether this desktop pulls its wake-ups, for the workspace's "Agent wakeups" line (a hosted supervisor cannot know). */
export function wakeupPullActive(): boolean { return pulling; }

/**
 * What to do with a wake-up its conversation refused: a spend cap clears when the person raises it, so it waits; a task that
 * is gone never comes back, so it is dropped with the reason; anything else (a restart, a busy store) is tried again.
 */
export function settlementFor(error: unknown): WakeupSettlement | undefined {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
  const code = typeof error === "object" && error && "body" in error ? (error.body as { code?: unknown } | undefined)?.code : undefined;
  if (status === 404 || (status === 409 && code !== "spend_cap")) return { outcome: "dropped", reason: error instanceof Error ? error.message : "The conversation refused this wake-up" };
  return undefined;
}

/** Starts pulling when this desktop talks to a hosted supervisor; returns undefined for the local one, which calls in itself. */
export function startWakeupPull(options: WakeupPullOptions): WakeupPull | undefined {
  let connection: ReturnType<typeof supervisorConnection>;
  try { connection = supervisorConnection(); } catch { return undefined; }
  const interval = options.intervalMs ?? Number(process.env.LATERDOG_WAKEUP_PULL_MS ?? 30_000);
  if (connection.source === "local" || !(interval > 0)) return undefined;
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? ((line: string) => console.warn(line));
  const call = async (path: string, body: unknown) => {
    // A sleeping hosted container takes a while to restore its state before it answers.
    const response = await fetcher(`${connection.origin}${path}`, { method: "POST", body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${desktopSupervisorToken()}`, "content-type": "application/json" } });
    if (!response.ok) throw new Error(`later.dog wake-ups: ${path} returned ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  async function pull(): Promise<number> {
    const bots = options.bots().slice(0, 1000);
    if (!bots.length) return 0;
    const { wakeups } = await call("/v1/wakeups/pull", { bots }) as { wakeups: Wakeup[] };
    let delivered = 0;
    for (const wakeup of wakeups) {
      let settlement: WakeupSettlement | undefined = { outcome: "delivered" };
      try { await options.send(wakeup); }
      catch (error) { settlement = settlementFor(error); if (!settlement) log(`later.dog wake-up ${wakeup.id} waits: ${error instanceof Error ? error.message : String(error)}`); }
      if (!settlement) continue;
      await call(`/v1/wakeups/${wakeup.id}`, settlement);
      if (settlement.outcome === "delivered") delivered++;
    }
    return delivered;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0; let lastError = "";
  const schedule = (delay: number) => { timer = setTimeout(tick, delay); timer.unref?.(); };
  async function tick() {
    try { await pull(); failures = 0; lastError = ""; }
    catch (error) {
      failures++;
      const text = error instanceof Error ? error.message : String(error);
      // One line per distinct failure; the supervisor keeps every wake-up until it is settled.
      if (text !== lastError) log(`later.dog wake-ups: ${text}; retrying with backoff`);
      lastError = text;
    }
    if (pulling) schedule(Math.min(interval * 2 ** Math.min(failures, 4), 300_000));
  }
  pulling = true;
  // The first pull waits for the server to finish starting.
  schedule(Math.min(interval, 3_000));
  return { pull, stop: () => { pulling = false; if (timer) clearTimeout(timer); } };
}
