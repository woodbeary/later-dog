import type { BatteryStatus } from "./account-battery.ts";

export type BatteryView = BatteryStatus & { waiting: Record<string, string> };

type Reach = "everyone" | "per-chat";

export const BATTERY_FIELDS = {
  enabled: "everyone",
  auto: "everyone",
  order: "everyone",
  sequence: "everyone",
  resting: "everyone",
  waiting: "per-chat",
  routed: "per-chat",
  fromNextMessage: "per-chat",
} as const satisfies { [K in keyof BatteryView]-?: Reach };

export function guestBattery(view: BatteryView): BatteryView {
  return Object.fromEntries(Object.entries(BATTERY_FIELDS)
    .map(([key, reach]) => [key, reach === "everyone" ? view[key as keyof BatteryView] : {}])) as unknown as BatteryView;
}
