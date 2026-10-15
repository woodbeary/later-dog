export function windowChoice({ state, autoMove }) {
  const accountId = state?.account?.id ?? null;
  const realSignOut = state?.status === "signed-out" && state.message !== "restoring";
  if (realSignOut || !accountId) return { kind: realSignOut ? "local" : "keep", signedOut: realSignOut };
  const machine = state.status === "connected" ? state.machine ?? null : null;
  if (machine?.status !== "ready" || !machine.origin) return { kind: "local", screen: "waking", accountId };
  if (autoMove === "moving") return { kind: "local", screen: "moving", accountId };
  if (autoMove === "failed") return { kind: "local", screen: null, accountId };
  return { kind: "cloud", origin: machine.origin, accountId };
}

export function createCloudWindow({ autoMove, hold, showHome, showLocal, destinationFor, log = () => {} }) {
  let working = null, again = null, moving = false, failed = null;

  async function settle(state) {
    const first = windowChoice({ state, autoMove: failed === state?.account?.id ? "failed" : moving ? "moving" : "pending" });
    if (first.kind === "keep") return first;
    if (first.signedOut) {
      autoMove.stop();
      failed = null;
      await hold.set(false);
      return first;
    }
    if (first.kind === "local") return first;
    const destination = destinationFor(first);
    moving = true;
    let outcome;
    try { outcome = await autoMove.ensure(first.accountId, destination); } finally { moving = false; }
    if (outcome.status === "busy") return { kind: "local", screen: "moving", accountId: first.accountId };
    if (outcome.status === "failed") {
      failed = first.accountId;
      await showLocal();
      return { kind: "local", screen: null, accountId: first.accountId };
    }
    failed = null;
    await hold.set(outcome.status === "moved");
    await showHome(destination);
    return { kind: "cloud", origin: first.origin, accountId: first.accountId, move: outcome.status };
  }

  function sync(state) {
    if (working) { again = state; return working; }
    working = (async () => {
      let result = await settle(state);
      while (again) { const next = again; again = null; result = await settle(next); }
      return result;
    })().catch(error => { log(`cloud window: ${error?.message ?? error}`); return { kind: "keep" }; }).finally(() => { working = null; });
    return working;
  }

  return { sync, retry: state => { failed = null; return sync(state); }, moving: () => moving };
}
