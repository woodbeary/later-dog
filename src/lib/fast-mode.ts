import type { InstanceInfo } from "@/state/store";

export function fastModeFits(instance: InstanceInfo | undefined, model: string): boolean {
  return instance?.capabilities?.fastMode === true && /opus/i.test(model);
}
