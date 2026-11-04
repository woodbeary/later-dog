export const ANSWER_CHECK_TIMEOUT_MS = 15_000;
export const RESTART_AFTER_MISSED_CHECKS = 4;

export interface AnswerRecord {
  answered: boolean;
  missed: number;
}

export const NOT_ANSWERED_YET: AnswerRecord = { answered: false, missed: 0 };

export type AnswerVerdict = { record: AnswerRecord; restart: boolean };

export function afterCheck(previous: AnswerRecord, answered: boolean, limit = RESTART_AFTER_MISSED_CHECKS): AnswerVerdict {
  if (answered) return { record: { answered: true, missed: 0 }, restart: false };
  if (!previous.answered) return { record: previous, restart: false };
  const missed = previous.missed + 1;
  if (missed >= limit) return { record: NOT_ANSWERED_YET, restart: true };
  return { record: { answered: true, missed }, restart: false };
}

export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work.catch(() => fallback), late]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

export function stuckLine(machineId: string, missed: number, everyS: number): string {
  return `laterdog home ${machineId}: stopped answering (${missed} checks in a row over ${Math.round((missed * everyS) / 60)} min); restarting it from its last save`;
}
