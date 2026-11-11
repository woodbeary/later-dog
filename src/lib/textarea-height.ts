export interface MeasuredTextBox {
  value: string;
  lineHeight: number;
  width: number;
  smallest: boolean;
  tallest: boolean;
}

export interface TextBoxNow {
  value: string;
  lineHeight: number;
  width: number;
}

export function textBoxHeightCanChange(last: MeasuredTextBox | null, now: TextBoxNow, overflows: () => boolean): boolean {
  if (!last || last.lineHeight !== now.lineHeight || last.width !== now.width) return true;
  if (last.value === now.value) return false;
  const onlyAdded = now.value.startsWith(last.value);
  if (!last.smallest && !onlyAdded) return true;
  if (last.tallest) return false;
  return overflows();
}
