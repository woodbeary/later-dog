export const INCLUDED_RENEW_MS = 80 * 24 * 60 * 60_000;

export function includedKeyDue(record: { createdAt: number; includedKey?: string; includedAt?: number }, now: number): boolean {
  if (!record.includedKey) return true;
  return now - (record.includedAt ?? record.createdAt) >= INCLUDED_RENEW_MS;
}
