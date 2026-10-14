import { arrivedInFull } from "./cloud-move.mjs";

export const AUTO_MOVE_RETRY_MS = Object.freeze([20_000, 60_000, 5 * 60_000, 15 * 60_000]);
const RETRYABLE = new Set(["busy", "network", "upload_failed", "cloud_unavailable", "cloud_busy", "proxy_limit", "cancelled", "restart_timeout", "unreachable"]);
const FINAL = new Set(["moved", "nothing", "kept-local"]);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function worthMoving(local) {
  return Boolean(local) && (local.bots > 1 || local.rooms > 0 || local.chats > 0);
}

export function parseMoveRecords(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
  const homes = value && typeof value === "object" && value.homes && typeof value.homes === "object" ? value.homes : {};
  const records = {};
  for (const [accountId, entry] of Object.entries(homes)) {
    if (!accountId || !entry || typeof entry !== "object" || !FINAL.has(entry.status) || !Number.isSafeInteger(entry.at)) continue;
    const contents = entry.contents && ["bots", "rooms", "chats"].every(key => count(entry.contents[key]))
      ? { bots: entry.contents.bots, rooms: entry.contents.rooms, chats: entry.contents.chats } : undefined;
    records[accountId] = { status: entry.status, at: entry.at, ...(typeof entry.origin === "string" ? { origin: entry.origin } : {}), ...(contents ? { contents } : {}) };
  }
  return records;
}

export function serializeMoveRecords(records) {
  return `${JSON.stringify({ version: 1, homes: records }, null, 2)}\n`;
}

export function createCloudAutoMove({ move, read, write, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, retryDelaysMs = AUTO_MOVE_RETRY_MS, log = () => {}, onMoved = () => {} }) {
  let busy = false, timer = null, failures = 0, closed = false, scheduled = null, gaveUp = null;
  const records = () => { try { return parseMoveRecords(read()); } catch { return {}; } };
  const remember = (accountId, entry) => {
    try { write(serializeMoveRecords({ ...records(), [accountId]: { ...entry, at: now() } })); } catch (error) { log(`cloud move: could not save the result (${error?.message ?? error})`); }
  };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; scheduled = null; };
  const forgetFailure = () => { gaveUp = null; failures = 0; };

  async function attempt(accountId, destination, manual) {
    if (closed || busy || move.running()) return { status: "busy" };
    const known = records()[accountId];
    if (known && (!manual || known.status !== "kept-local")) return { status: known.status };
    busy = true;
    try {
      let local = null;
      try { local = await move.estimate(); } catch { local = null; }
      if (!local) return retryLater(accountId, destination, "unmeasured");
      if (!worthMoving(local)) {
        remember(accountId, { status: "nothing", origin: destination.origin });
        return { status: "nothing" };
      }
      const result = await move.move(destination, { requireEmpty: true, verifyArrival: true });
      if (result.phase === "done" && arrivedInFull(local, result.moved)) {
        failures = 0;
        remember(accountId, { status: "moved", origin: destination.origin, contents: result.moved });
        onMoved(destination);
        return { status: "moved" };
      }
      const code = result.error?.code;
      if (code === "not_empty") {
        if (arrivedInFull(local, result.error.contents)) {
          remember(accountId, { status: "moved", origin: destination.origin, contents: result.error.contents });
          onMoved(destination);
          return { status: "moved" };
        }
        remember(accountId, { status: "kept-local", origin: destination.origin });
        return { status: "kept-local" };
      }
      if (RETRYABLE.has(code)) return retryLater(accountId, destination, code);
      gaveUp = accountId;
      return { status: "failed", code };
    } finally { busy = false; }
  }

  function retryLater(accountId, destination, code) {
    if (closed || failures >= retryDelaysMs.length) { gaveUp = accountId; return { status: "failed", code }; }
    const delay = retryDelaysMs[failures++];
    stopTimer();
    scheduled = accountId;
    timer = setTimer(() => { timer = null; scheduled = null; void attempt(accountId, destination, false).catch(() => {}); }, delay);
    timer?.unref?.();
    return { status: "waiting", code };
  }

  return {
    status(accountId) { return records()[accountId]?.status ?? null; },
    ensure(accountId, destination) {
      if (!accountId || closed) return Promise.resolve({ status: "busy" });
      if (scheduled === accountId) return Promise.resolve({ status: "waiting" });
      if (gaveUp === accountId) return Promise.resolve({ status: "failed" });
      return attempt(accountId, destination, false);
    },
    retry(accountId, destination) {
      forgetFailure();
      stopTimer();
      return attempt(accountId, destination, true);
    },
    stop() { stopTimer(); forgetFailure(); },
    close() { closed = true; stopTimer(); },
  };
}
