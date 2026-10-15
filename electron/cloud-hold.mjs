export const CLOUD_HOLD_ROUTE = "/api/cloud-hold";

export function createMacHold({ request, log = () => {} }) {
  let desired = null, applied = null, working = null, again = false;

  async function push() {
    if (desired === null || desired === applied) return;
    const wanted = desired;
    try {
      const response = await request(CLOUD_HOLD_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ held: wanted }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applied = wanted;
    } catch (error) {
      log(`cloud hold: ${wanted ? "pausing" : "resuming"} this Mac's dogs did not apply yet (${error?.message ?? error})`);
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
    set(held) { desired = held === true; return flush(); },
    flush,
    held: () => applied === true,
    wanted: () => desired,
  };
}
