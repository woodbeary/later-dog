import type { ModelSelection } from "./wire.ts";

export function sameModelSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;
}
