import type { Wakeup, WakeupSettlement } from "../../shared/laterdog.ts";
import { desktopSupervisorToken, supervisorConnection } from "./config.ts";

export interface WakeupPullOptions {
  bots(): string[];
  send(wakeup: Wakeup): Promise<unknown>;
  intervalMs?: number;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}
export interface WakeupPull { pull(): Promise<number>; stop(): void }

let pulling = false;
export function wakeupPullActive(): boolean { return pulling; }

export function settlementFor(error: unknown): WakeupSettlement | undefined {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
  const code = typeof error === "object" && error && "body" in error ? (error.body as { code?: unknown } | undefined)?.code : undefined;
  if (status === 404 || (status === 409 && code !== "spend_cap")) return { outcome: "dropped", reason: error instanceof Error ? error.message : "The conversation refused this wake-up" };
  return undefined;
}

export function startWakeupPull(options: WakeupPullOptions): WakeupPull | undefined {
  let connection: ReturnType<typeof supervisorConnection>;
  try { connection = supervisorConnection(); } catch { return undefined; }
  const interval = options.intervalMs ?? Number(process.env.LATERDOG_WAKEUP_PULL_MS ?? 30_000);
  if (connection.source === "local" || !(interval > 0)) return undefined;
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? ((line: string) => console.warn(line));
  const call = async (path: string, body: unknown) => {
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
      if (text !== lastError) log(`later.dog wake-ups: ${text}; retrying with backoff`);
      lastError = text;
    }
    if (pulling) schedule(Math.min(interval * 2 ** Math.min(failures, 4), 300_000));
  }
  pulling = true;
  schedule(Math.min(interval, 3_000));
  return { pull, stop: () => { pulling = false; if (timer) clearTimeout(timer); } };
}
