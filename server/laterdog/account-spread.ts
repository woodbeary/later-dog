export const NEARLY_EMPTY_PERCENT = 5;

export function roomTier(left: number | undefined): 0 | 1 | 2 {
  if (left === undefined) return 1;
  return left > NEARLY_EMPTY_PERCENT ? 0 : 2;
}
