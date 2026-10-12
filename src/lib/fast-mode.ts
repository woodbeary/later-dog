import type { InstanceInfo } from "@/state/store";

/** Fast mode (same model, faster output) is Claude Code's, for Opus. */
export function fastModeFits(instance: InstanceInfo | undefined, model: string): boolean {
  return instance?.capabilities?.fastMode === true && /opus/i.test(model);
}
