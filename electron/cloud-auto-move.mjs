import { arrivedInFull, CLOUD_MOVE_PROFILE } from "./cloud-move.mjs";

const FINAL = new Set(["moved", "joined"]);
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
    if (!accountId || !entry || typeof entry !== "object" || !FINAL.has(entry.status) || !Number.isSafeInteger(entry.at) || typeof entry.origin !== "string") continue;
    const contents = entry.contents && ["bots", "rooms", "chats"].every(key => count(entry.contents[key]))
      ? { bots: entry.contents.bots, rooms: entry.contents.rooms, chats: entry.contents.chats } : undefined;
    const stayedOnMac = Array.isArray(entry.stayedOnMac)
      ? entry.stayedOnMac.filter(item => item && typeof item.name === "string" && count(item.bytes)).map(item => ({ name: item.name, bytes: item.bytes })) : undefined;
    records[accountId] = { status: entry.status, at: entry.at, origin: entry.origin, ...(contents ? { contents } : {}), ...(stayedOnMac ? { stayedOnMac } : {}) };
  }
  return records;
}

export function serializeMoveRecords(records) {
  return `${JSON.stringify({ version: 2, homes: records }, null, 2)}\n`;
}

export function createCloudAutoMove({ move, read, write, now = Date.now, log = () => {}, onMoved = () => {}, onJoined = () => {}, onFailed = () => {} }) {
  let busy = false, failedFor = null, closed = false;
  const records = () => { try { return parseMoveRecords(read()); } catch { return {}; } };
  const known = (accountId, destination) => {
    const entry = records()[accountId];
    return entry && entry.origin === destination.origin ? entry : null;
  };
  const remember = (accountId, entry) => {
    try { write(serializeMoveRecords({ ...records(), [accountId]: { ...entry, at: now() } })); } catch (error) { log(`cloud move: could not save the result (${error?.message ?? error})`); }
  };
  const fail = (accountId, code, message) => {
    failedFor = accountId;
    log(`cloud move: not moved (${code})`);
    try { onFailed({ code, message }); } catch {}
    return { status: "failed", code };
  };

  async function attempt(accountId, destination) {
    if (closed || busy || move.running()) return { status: "busy" };
    const done = known(accountId, destination);
    if (done) return { status: done.status };
    busy = true;
    try {
      let local = null;
      try { local = await move.estimate(); } catch { local = null; }
      if (!local) return fail(accountId, "unmeasured", "This Mac's dogs could not be measured. They will be tried again next time the app opens.");
      if (!worthMoving(local)) return { status: "nothing" };
      const result = await move.move(destination, { requireEmpty: false, verifyArrival: true, profile: CLOUD_MOVE_PROFILE, yieldToOtherComputer: true });
      if (result.phase === "done" && arrivedInFull(local, result.moved)) {
        failedFor = null;
        remember(accountId, { status: "moved", origin: destination.origin, contents: result.moved, ...(result.stayedOnMac ? { stayedOnMac: result.stayedOnMac } : {}) });
        try { onMoved(destination, result); } catch {}
        return { status: "moved" };
      }
      const code = result.error?.code ?? "unknown";
      if (code === "other_computer_moved") {
        remember(accountId, { status: "joined", origin: destination.origin });
        log("cloud move: another computer already moved its dogs to this account; showing the Cloud home and leaving this Mac's data as it is");
        try { onJoined(destination); } catch {}
        return { status: "joined" };
      }
      return fail(accountId, code, result.error?.message ?? "The move did not finish.");
    } finally { busy = false; }
  }

  return {
    status(accountId, destination) { return destination ? known(accountId, destination)?.status ?? null : records()[accountId]?.status ?? null; },
    ensure(accountId, destination) {
      if (!accountId || closed) return Promise.resolve({ status: "busy" });
      if (failedFor === accountId) return Promise.resolve({ status: "failed" });
      return attempt(accountId, destination);
    },
    retry(accountId, destination) {
      failedFor = null;
      return attempt(accountId, destination);
    },
    stop() { failedFor = null; },
    close() { closed = true; },
  };
}
