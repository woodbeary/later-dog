import type { RoutineSchedule } from "./routine-occurrence.ts";

export const ROUTINES_ROUTE = "/api/internal/coordinator/routines";
export const INBOX_ROUTE = "/api/internal/coordinator/inbox";
export const DOG_CHAT = "dog";

export interface ObjectRoutine {
  id: string;
  schedule: RoutineSchedule;
  nextRunAt: number | null;
  enabled: boolean;
}

export type OccurrenceState = "due" | "started" | "settled";

export interface Occurrence {
  id: string;
  routineId: string;
  scheduledFor: number;
  nextRunAt: number | null;
  missed: boolean;
  state: OccurrenceState;
  runId: string | null;
  firedAt: number;
}

export interface ScheduleView {
  id: string;
  nextRunAt: number | null;
  enabled: boolean;
}

export type RoutinesRequest =
  | { op: "put"; timeZone: string; routines: ObjectRoutine[] }
  | { op: "claim" }
  | { op: "settle"; id: string; state: Exclude<OccurrenceState, "due">; runId: string }
  | { op: "export" };

export interface RoutinesAnswer {
  ok: true;
  schedules: ScheduleView[];
  occurrences: Occurrence[];
}

export interface InboxLetter {
  clientId: string;
  from: string;
  fromChat: string;
  toChat: string | null;
  text: string;
  replyTo: string | null;
  at: number;
}

export type LetterState = "accepted" | "delivered";

export interface StoredLetter extends InboxLetter {
  seq: number;
  state: LetterState;
  deliveredAt: number | null;
}

export type InboxRequest =
  | { op: "put"; letter: InboxLetter }
  | { op: "pull"; after?: number; limit?: number }
  | { op: "ack"; clientIds: string[] }
  | { op: "status"; clientIds: string[] };

export const MAX_LETTER_CHARS = 64 * 1024;
const ID = /^[\w:.-]{1,160}$/;

export function validObjectId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function validLetter(value: unknown): value is InboxLetter {
  if (!value || typeof value !== "object") return false;
  const letter = value as Record<string, unknown>;
  return validObjectId(letter.clientId) && validObjectId(letter.from) && validObjectId(letter.fromChat) &&
    (letter.toChat === null || validObjectId(letter.toChat)) &&
    typeof letter.text === "string" && letter.text.length > 0 && letter.text.length <= MAX_LETTER_CHARS &&
    (letter.replyTo === null || validObjectId(letter.replyTo)) &&
    typeof letter.at === "number" && Number.isSafeInteger(letter.at) && letter.at > 0;
}
