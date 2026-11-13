export interface CreditsRecord {
  unlimited: boolean;
  balance: string | null;
}

export function creditsSpendable(credits: CreditsRecord | null | undefined): boolean {
  if (!credits) return false;
  if (credits.unlimited) return true;
  const balance = typeof credits.balance === "string" ? credits.balance.trim() : "";
  if (!balance) return true;
  const amount = Number(balance);
  return Number.isNaN(amount) || amount > 0;
}
