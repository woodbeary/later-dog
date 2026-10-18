export const INCLUDED_RENEW_MS = 80 * 24 * 60 * 60_000;

export interface IncludedGrant {
  createdAt: number;
  includedKey?: string;
  includedAt?: number;
  includedHome?: true;
}

export function includedKeyDue(record: IncludedGrant, now: number): boolean {
  if (!record.includedKey || !record.includedHome) return true;
  return now - (record.includedAt ?? record.createdAt) >= INCLUDED_RENEW_MS;
}

export async function grantedAsHome(response: Response): Promise<boolean> {
  const answer = (await response.json().catch(() => null)) as { home?: unknown } | null;
  return answer?.home === true;
}
