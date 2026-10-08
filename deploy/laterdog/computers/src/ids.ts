// Computer IDs: "cmp_" followed by 12 lowercase base32 characters (RFC 4648 alphabet, 60 random bits).

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const COMPUTER_ID = /^cmp_[a-z2-7]{12}$/;

export function newComputerId(fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = fill(new Uint8Array(12));
  let id = "cmp_";
  // 256 is a multiple of 32, so the low five bits of a uniform byte are uniform.
  for (const byte of bytes) id += BASE32[byte & 31];
  return id;
}

export function isComputerId(value: string): boolean {
  return COMPUTER_ID.test(value);
}
