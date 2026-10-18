export function windowChoice({ state, autoMove }) {
  const accountId = state?.account?.id ?? null;
  const realSignOut = state?.status === "signed-out" && state.message !== "restoring";
  if (realSignOut) return { kind: "local", signedOut: true };
  if (!accountId) return { kind: "keep" };
  const machine = state.status === "connected" ? state.machine ?? null : null;
  if (machine?.status !== "ready" || !machine.origin || autoMove === "moving") return { kind: "keep" };
  return { kind: "cloud", origin: machine.origin, accountId };
}

const laterBy = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return timer;
};

const RETRY_AGAIN_MS = 60_000;
const sameAccount = (state, accountId) => state?.status !== "signed-out" && state?.account?.id === accountId;

export function createCloudWindow({ autoMove, hold, showHome, destinationFor, log = () => {}, setTimer = laterBy, clearTimer = clearTimeout, retryWith = null }) {
  let working = null, again = null, againManual = false, moving = false, latest = null, timer = null, attempts = 0, closed = false;

  function cancelRetry() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function retryLater(ms) {
    cancelRetry();
    if (closed) return;
    timer = setTimer(async () => {
      timer = null;
      const before = attempts;
      const result = await (retryWith ? retryWith(latest) : retry(latest));
      if (attempts === before && !result?.signedOut && sameAccount(latest, latest?.account?.id)) retryLater(RETRY_AGAIN_MS);
    }, ms);
  }

  async function settle(state, manual = false) {
    const first = windowChoice({ state, autoMove: moving ? "moving" : "pending" });
    if (first.kind === "keep") return first;
    if (first.signedOut) {
      autoMove.stop();
      cancelRetry();
      await hold.set(false);
      return first;
    }
    const destination = destinationFor(first);
    moving = true;
    attempts++;
    let outcome;
    try { outcome = await (manual ? autoMove.retry(first.accountId, destination) : autoMove.ensure(first.accountId, destination)); } finally { moving = false; }
    if (!sameAccount(latest, first.accountId)) return { kind: "keep" };
    if (outcome.status === "busy") return { kind: "keep" };
    if (outcome.status === "failed") {
      if (outcome.retryInMs) retryLater(outcome.retryInMs);
      await showHome(destination);
      return { kind: "cloud", origin: first.origin, accountId: first.accountId, move: "failed" };
    }
    await hold.set(outcome.status === "moved");
    await showHome(destination);
    return { kind: "cloud", origin: first.origin, accountId: first.accountId, move: outcome.status };
  }

  async function settleQuietly(state, manual) {
    try { return await settle(state, manual); } catch (error) {
      log(`cloud window: ${error?.message ?? error}`);
      return { kind: "keep" };
    }
  }

  function sync(state, manual = false) {
    latest = state;
    if (working) { again = state; againManual = againManual || manual; return working; }
    working = (async () => {
      let result = await settleQuietly(state, manual);
      while (again) {
        const next = again, nextManual = againManual;
        again = null; againManual = false;
        result = await settleQuietly(next, nextManual);
      }
      return result;
    })().finally(() => { working = null; });
    return working;
  }

  function retry(state) {
    return sync(state, true);
  }

  return { sync, retry, cancelRetry, close: () => { closed = true; cancelRetry(); }, moving: () => moving };
}
