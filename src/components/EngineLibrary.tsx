import type { InstanceInfo } from "@/state/store";

export function engineReady(instance: InstanceInfo): boolean {
  return instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false);
}
