export const RESTORE_BACKOFF_STEP_MS = 2_000;
export const RESTORE_BACKOFF_MAX_MS = 30_000;
export const RESTORE_NOTES_KEPT = 20;

export function restoreBackoff(attempt) {
  return Math.min(attempt * RESTORE_BACKOFF_STEP_MS, RESTORE_BACKOFF_MAX_MS);
}

export function describeRestoreFailure(error) {
  const code = typeof error?.code === "string" ? ` [${error.code}]` : "";
  const cause = error?.cause?.message ? ` (${error.cause.message}${typeof error.cause.code === "string" ? ` [${error.cause.code}]` : ""})` : "";
  return `${error?.name && error.name !== "Error" ? `${error.name}: ` : ""}${error?.message ?? String(error)}${code}${cause}`.slice(0, 400);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function restoreUntilDone(attemptRestore, { finished = new Set(), log = () => {}, now = Date.now, wait = pause, giveUpMs = Infinity } = {}) {
  const started = now();
  const notes = [];
  for (let attempt = 1; ; attempt += 1) {
    const before = finished.size;
    try {
      const restored = await attemptRestore(finished);
      return { ...restored, attempts: attempt, notes, ms: now() - started };
    } catch (error) {
      const said = `restore attempt ${attempt} failed after ${finished.size - before} more file(s) came back, ${finished.size} in all, ${Math.round((now() - started) / 1000)} s in: ${describeRestoreFailure(error)}`;
      notes.push(said);
      if (notes.length > RESTORE_NOTES_KEPT) notes.shift();
      log(said);
      if (now() - started >= giveUpMs) throw error;
      await wait(restoreBackoff(attempt));
    }
  }
}
