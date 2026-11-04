export const ANSWER_CHECK_TIMEOUT_MS = 15_000;
export const RESTART_AFTER_SILENT_MS = 4 * 60_000;
export const RESTART_AFTER_MISSED_CHECKS = 2;

export interface AnswerRecord {
  answeredAt: number | null;
  missed: number;
}

export const NOT_ANSWERED_YET: AnswerRecord = { answeredAt: null, missed: 0 };

export type AnswerVerdict = { record: AnswerRecord; restart: boolean };

export function afterCheck(previous: AnswerRecord, answered: boolean, now: number): AnswerVerdict {
  if (answered) return { record: { answeredAt: now, missed: 0 }, restart: false };
  if (previous.answeredAt === null) return { record: previous, restart: false };
  const missed = previous.missed + 1;
  if (missed >= RESTART_AFTER_MISSED_CHECKS && now - previous.answeredAt >= RESTART_AFTER_SILENT_MS) return { record: NOT_ANSWERED_YET, restart: true };
  return { record: { answeredAt: previous.answeredAt, missed }, restart: false };
}

export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work.catch(() => fallback), late]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

export function stuckLine(machineId: string, record: AnswerRecord, now: number): string {
  const silentMin = record.answeredAt === null ? 0 : Math.round((now - record.answeredAt) / 60_000);
  return `laterdog home ${machineId}: stopped answering (no answer for ${silentMin} min, ${record.missed} checks missed in a row); restarting it from its last save`;
}
