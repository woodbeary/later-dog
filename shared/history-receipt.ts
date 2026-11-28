export const HISTORY_RECEIPT_PREFIX = "history:v1:";
export function receiptDigest(reference: string): string {
  const digest = reference.slice(HISTORY_RECEIPT_PREFIX.length);
  if (!reference.startsWith(HISTORY_RECEIPT_PREFIX) || !/^[a-f0-9]{64}$/.test(digest))
    throw Error("Invalid conversation command receipt reference");
  return digest;
}
