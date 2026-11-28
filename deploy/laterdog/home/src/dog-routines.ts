import { dueOccurrence, loadSchedule, zoneClock, type RoutineSchedule, type WallClock } from "../../../../shared/routine-occurrence.ts";
import { validObjectId, type ObjectRoutine, type Occurrence, type OccurrenceState, type RoutinesAnswer, type ScheduleView } from "../../../../shared/dog-object-protocol.ts";

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface AlarmClock {
  set(at: number): Promise<void>;
  clear(): Promise<void>;
}

export interface DogRoutinesPort {
  putRoutines(timeZone: string, routines: ObjectRoutine[]): Promise<RoutinesAnswer>;
  claimRoutines(): Promise<RoutinesAnswer>;
  settleRoutine(id: string, state: Exclude<OccurrenceState, "due">, runId: string): Promise<RoutinesAnswer | null>;
  exportRoutines(): Promise<RoutinesAnswer>;
  fireRoutines(): Promise<number>;
  nextAlarmAt(): number | null;
}

export const SETTLED_KEPT_MS = 7 * 24 * 60 * 60_000;
export const MAX_ROUTINES = 500;

function validZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validTime(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export function validObjectRoutine(value: unknown): value is ObjectRoutine {
  if (!value || typeof value !== "object") return false;
  const routine = value as Record<string, unknown>;
  return validObjectId(routine.id) && typeof routine.enabled === "boolean" && validTime(routine.nextRunAt) &&
    loadSchedule(routine.schedule, 0) !== null;
}

export function dogRoutines(sql: Sql, alarm: AlarmClock, now: () => number = Date.now): DogRoutinesPort {
  sql.exec(`CREATE TABLE IF NOT EXISTS dog_routines (
    id TEXT PRIMARY KEY,
    schedule TEXT NOT NULL,
    next_run_at INTEGER,
    enabled INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS dog_occurrences (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    next_run_at INTEGER,
    missed INTEGER NOT NULL,
    state TEXT NOT NULL,
    run_id TEXT,
    fired_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS dog_occurrences_open ON dog_occurrences (state, scheduled_for)");
  sql.exec("CREATE TABLE IF NOT EXISTS dog_routine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const zone = (): WallClock | undefined => {
    const row = sql.exec("SELECT value FROM dog_routine_settings WHERE key = 'zone'").toArray()[0];
    return row ? zoneClock(String(row.value)) : undefined;
  };

  const schedules = (): ScheduleView[] =>
    sql.exec("SELECT id, next_run_at, enabled FROM dog_routines ORDER BY id").toArray()
      .map((row) => ({ id: String(row.id), nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at), enabled: Number(row.enabled) === 1 }));

  const occurrences = (open: boolean): Occurrence[] =>
    sql.exec(`SELECT * FROM dog_occurrences ${open ? "WHERE state != 'settled'" : ""} ORDER BY scheduled_for, id`).toArray()
      .map((row) => ({
        id: String(row.id),
        routineId: String(row.routine_id),
        scheduledFor: Number(row.scheduled_for),
        nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
        missed: Number(row.missed) === 1,
        state: String(row.state) as OccurrenceState,
        runId: row.run_id === null ? null : String(row.run_id),
        firedAt: Number(row.fired_at),
      }));

  const answer = (open = true): RoutinesAnswer => ({ ok: true, schedules: schedules(), occurrences: occurrences(open) });

  const nextAlarmAt = (): number | null => {
    const row = sql.exec("SELECT MIN(next_run_at) AS at FROM dog_routines WHERE enabled = 1 AND next_run_at IS NOT NULL").toArray()[0];
    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  };

  const rearm = async () => {
    const earliest = nextAlarmAt();
    if (earliest === null) await alarm.clear();
    else await alarm.set(earliest);
  };

  const fire = async (): Promise<number> => {
    const at = now();
    const clock = zone();
    let fired = 0;
    const due = sql.exec("SELECT id, schedule, next_run_at FROM dog_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?", at).toArray();
    for (const row of due) {
      const schedule = JSON.parse(String(row.schedule)) as RoutineSchedule;
      const occurrence = dueOccurrence(schedule, Number(row.next_run_at), at, clock);
      const id = `${String(row.id)}-at-${occurrence.scheduledFor}`;
      const inserted = sql.exec(
        "INSERT INTO dog_occurrences (id, routine_id, scheduled_for, next_run_at, missed, state, run_id, fired_at, changed_at) VALUES (?, ?, ?, ?, ?, 'due', NULL, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id",
        id, String(row.id), occurrence.scheduledFor, occurrence.nextRunAt, occurrence.missed ? 1 : 0, at, at,
      ).toArray();
      fired += inserted.length;
      const ends = schedule.type === "once" || (schedule.type === "interval" && occurrence.nextRunAt === null);
      sql.exec("UPDATE dog_routines SET next_run_at = ?, enabled = ? WHERE id = ?", occurrence.nextRunAt, ends ? 0 : 1, String(row.id));
    }
    sql.exec("DELETE FROM dog_occurrences WHERE state = 'settled' AND changed_at < ?", at - SETTLED_KEPT_MS);
    await rearm();
    return fired;
  };

  return {
    async putRoutines(timeZone, routines) {
      if (validZone(timeZone)) sql.exec("INSERT INTO dog_routine_settings (key, value) VALUES ('zone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", timeZone);
      const kept = new Set<string>();
      for (const routine of routines.slice(0, MAX_ROUTINES)) {
        kept.add(routine.id);
        const schedule = JSON.stringify(routine.schedule);
        const held = sql.exec("SELECT schedule, enabled FROM dog_routines WHERE id = ?", routine.id).toArray()[0];
        if (held && String(held.schedule) === schedule && (Number(held.enabled) === 1) === routine.enabled) continue;
        sql.exec(
          "INSERT INTO dog_routines (id, schedule, next_run_at, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET schedule = excluded.schedule, next_run_at = excluded.next_run_at, enabled = excluded.enabled",
          routine.id, schedule, routine.nextRunAt, routine.enabled ? 1 : 0,
        );
      }
      for (const row of sql.exec("SELECT id FROM dog_routines").toArray()) {
        if (!kept.has(String(row.id))) sql.exec("DELETE FROM dog_routines WHERE id = ?", String(row.id));
      }
      await fire();
      return answer();
    },
    async claimRoutines() {
      await fire();
      return answer();
    },
    async settleRoutine(id, state, runId) {
      const held = sql.exec("SELECT state, run_id FROM dog_occurrences WHERE id = ?", id).toArray()[0];
      if (!held) return null;
      if (held.run_id !== null && String(held.run_id) !== runId) return null;
      const order: Record<OccurrenceState, number> = { due: 0, started: 1, settled: 2 };
      if (order[state] > order[String(held.state) as OccurrenceState]) {
        sql.exec("UPDATE dog_occurrences SET state = ?, run_id = ?, changed_at = ? WHERE id = ?", state, runId, now(), id);
      }
      return answer();
    },
    async exportRoutines() {
      const exported = answer();
      sql.exec("DELETE FROM dog_routines");
      await rearm();
      return exported;
    },
    fireRoutines: fire,
    nextAlarmAt,
  };
}
