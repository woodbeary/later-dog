import type { ConfigStatus } from "@/state/store";
import { sameModel } from "../../shared/model-family";

type Battery = NonNullable<ConfigStatus["accountBattery"]>;
export type AccountRestShown = NonNullable<Battery["resting"]>[string] & { label?: string };

export function restingFor(battery: Pick<Battery, "resting" | "modelResting"> | undefined, model: string | undefined, now: number): Record<string, AccountRestShown> {
  const live = (rest: AccountRestShown | undefined) => Boolean(rest && Date.parse(rest.until) > now);
  const found: Record<string, AccountRestShown> = { ...battery?.resting };
  if (!model) return found;
  for (const [instanceId, rests] of Object.entries(battery?.modelResting ?? {})) {
    const whole = found[instanceId];
    if (live(whole)) continue;
    const own = rests.find((rest) => sameModel(rest.model, model));
    if (own && (live(own) || !whole)) found[instanceId] = own;
  }
  return found;
}
