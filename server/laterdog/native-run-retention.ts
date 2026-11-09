import type { ThreadLogRetentionCandidate } from "../thread-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function threadsPastRetention(candidates: Iterable<ThreadLogRetentionCandidate>, retentionDays: number, now: number): string[] {
  const cutoff = now - retentionDays * DAY_MS;
  const due: string[] = [];
  for (const candidate of candidates) {
    if (candidate.unread || candidate.busy || candidate.openDirectHandoff) continue;
    const stamps = [candidate.closedAt, candidate.archivedAt].filter((value): value is number => value !== null);
    if (stamps.length && Math.max(...stamps) < cutoff) due.push(candidate.threadId);
  }
  return due;
}
