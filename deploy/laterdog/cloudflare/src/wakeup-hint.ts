// Lets the Worker answer a desktop's wake-up pull without waking a sleeping container. The supervisor's answers to the
// admin token name the dogs that have a wake-up waiting (server/laterdog/http.ts, wakeupReport); the Durable Object keeps
// the last report, and a pull that names none of those dogs is answered here with nothing to deliver.

/** The header the supervisor reports in: a JSON list of bot IDs, or "*" when there are too many to list. */
export const WAKEUP_BOTS_HEADER = "x-laterdog-wakeup-bots";

/**
 * Whether a pull (its JSON body, `{ bots: string[] }`) might find a wake-up. Anything unknown — no report yet, "*", or a body
 * that does not parse — goes to the supervisor, which answers authoritatively.
 */
export function mayHaveWakeups(report: string | undefined, pullBody: string): boolean {
  if (report === undefined || report === "*") return true;
  let waiting: unknown;
  let bots: unknown;
  try {
    waiting = JSON.parse(report);
    bots = (JSON.parse(pullBody) as { bots?: unknown }).bots;
  } catch {
    return true;
  }
  if (!Array.isArray(waiting) || !Array.isArray(bots)) return true;
  return bots.some((bot) => waiting.includes(bot));
}
