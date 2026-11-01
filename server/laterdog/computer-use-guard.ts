import type { ComputerAction } from "./computer-use-actions.ts";
import type { Point, Size } from "./computer-use-frame.ts";

export const GUARD_CROP: Size = { width: 480, height: 240 };
export const CONFIRM_LOOKS_MS = [1_000, 2_000, 3_000] as const;
const SUBMIT_KEY = /(^|\+)(Return|KP_Enter|Enter)$/i;

export type GuardedAction = Extract<ComputerAction, { kind: "click" | "key" }>;

export function isGuarded(action: ComputerAction): action is GuardedAction {
  if (action.kind === "click") return action.button === "left";
  return action.kind === "key" && SUBMIT_KEY.test(action.keys);
}

export function guardedWords(name: string, input: unknown): string {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const at = Array.isArray(args.coordinate) && args.coordinate.length === 2 ? ` at (${args.coordinate.join(", ")})` : "";
  return name === "key" ? `key ${String(args.text)}` : `${name}${at || " where the pointer is"}`;
}

export function cropBox(center: Point, screen: Size, crop: Size = GUARD_CROP): { x: number; y: number; width: number; height: number } {
  const width = Math.min(crop.width, screen.width);
  const height = Math.min(crop.height, screen.height);
  const x = Math.min(Math.max(center[0] - Math.floor(width / 2), 0), screen.width - width);
  const y = Math.min(Math.max(center[1] - Math.floor(height / 2), 0), screen.height - height);
  return { x, y, width, height };
}
