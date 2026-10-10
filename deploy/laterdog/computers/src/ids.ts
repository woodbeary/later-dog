// Computer IDs: "cmp_" followed by 12 lowercase base32 characters (RFC 4648 alphabet, 60 random bits).

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const COMPUTER_ID = /^cmp_[a-z2-7]{12}$/;
export const TRIAL_ID = /^trl_[a-z2-7]{16}$/;

type Fill = (bytes: Uint8Array) => Uint8Array;

const random: Fill = (bytes) => crypto.getRandomValues(bytes);

function base32(length: number, fill: Fill): string {
  let text = "";
  // 256 is a multiple of 32, so the low five bits of a uniform byte are uniform.
  for (const byte of fill(new Uint8Array(length))) text += BASE32[byte & 31];
  return text;
}

export function newComputerId(fill: Fill = random): string {
  return `cmp_${base32(12, fill)}`;
}

export function newTrialId(fill: Fill = random): string {
  return `trl_${base32(16, fill)}`;
}

export function isComputerId(value: string): boolean {
  return COMPUTER_ID.test(value);
}
