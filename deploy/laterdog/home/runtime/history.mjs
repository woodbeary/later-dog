import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export async function bootHistory(env, request = fetch) {
  const url = env.LATERDOG_HISTORY_URL,
    token = env.LATERDOG_HISTORY_TOKEN;
  if (!url && !token) return { mode: "legacy", generation: null };
  if (!url || !token) throw Error("History configuration is incomplete");
  const res = await request(url + "/status", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Error("History status returned " + res.status);
  const value = await res.json();
  if (value.mode === "held") throw Error("Conversation history is held for maintenance");
  if (
    !["legacy", "remote", "dual"].includes(value.mode) ||
    (value.mode !== "legacy" && typeof value.generation !== "string")
  )
    throw Error("History status is invalid");
  return value;
}
export function historyExclusion(mode, path) {
  return mode === "remote"
    ? /^\.laterdog\/messages\.db(?:-(?:wal|shm|journal))?$/.test(path)
    : /^\.laterdog\/history-control\.db(?:-(?:wal|shm|journal))?$/.test(path);
}
export function verifyHistoryControl(data, generation) {
  const database = new DatabaseSync(join(data, "history-control.db"), { readOnly: true });
  try {
    if (
      database.prepare("SELECT generation FROM history_control_generation WHERE singleton=1").get()?.generation !==
      generation
    )
      throw Error("Conversation history control generation does not match");
    for (const table of [
      "messages",
      "thread_state",
      "native_runs",
      "native_run_events",
      "native_run_items",
      "native_run_retention",
    ]) {
      if (database.prepare("SELECT 1 FROM " + table + " LIMIT 1").get())
        throw Error("The compact history control contains remote history");
    }
  } finally {
    database.close();
  }
}
