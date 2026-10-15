export const CLOUD_HOLD_ROUTE = "/api/cloud-hold";
export const HOLD_RETRY_MS = Object.freeze([2_000, 5_000, 15_000, 30_000, 60_000]);

const laterBy = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return timer;
};

const why = error => {
  const code = error?.cause?.code ?? error?.cause?.message;
  return `${error?.message ?? error}${code ? `: ${code}` : ""}`;
};

export function createMacHold({ request, log = () => {}, retryMs = HOLD_RETRY_MS, setTimer = laterBy, clearTimer = clearTimeout }) {
  let desired = null, applied = null, working = null, again = false, failures = 0, retry = null;

  function cancelRetry() {
    if (retry) clearTimer(retry);
    retry = null;
  }

  async function push() {
    if (desired === null || desired === applied) return;
    const wanted = desired;
    const doing = wanted ? "pausing" : "resuming";
    try {
      const response = await request(CLOUD_HOLD_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ held: wanted }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applied = wanted;
      if (failures > 0) log(`cloud hold: ${doing} this Mac's dogs applied on try ${failures + 1}`);
      failures = 0;
    } catch (error) {
      const wait = retryMs[failures++];
      log(`cloud hold: ${doing} this Mac's dogs did not apply yet (${why(error)})${wait === undefined ? "" : `; trying again in ${Math.round(wait / 1000)} s`}`);
      if (wait !== undefined && !retry) retry = setTimer(() => { retry = null; void flush(); }, wait);
    }
  }

  function flush() {
    if (working) { again = true; return working; }
    working = (async () => {
      do { again = false; await push(); } while (again);
    })().finally(() => { working = null; });
    return working;
  }

  return {
    set(held) {
      const next = held === true;
      if (next !== desired) { failures = 0; cancelRetry(); }
      desired = next;
      return flush();
    },
    flush() { cancelRetry(); return flush(); },
    held: () => applied === true,
    wanted: () => desired,
    close: cancelRetry,
  };
}
