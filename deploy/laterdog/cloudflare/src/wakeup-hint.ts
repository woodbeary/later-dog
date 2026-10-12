
export const WAKEUP_BOTS_HEADER = "x-laterdog-wakeup-bots";

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
