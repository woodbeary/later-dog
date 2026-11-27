import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CAPABILITY_MODES = ["random", "signed"] as const;
export const QUEUE_MODES = ["container", "object"] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export type QueueMode = (typeof QUEUE_MODES)[number];
export const EVERY_DOG = "*";

export interface CoordinatorSetting {
  capabilities: CapabilityMode;
  queue: Record<string, QueueMode>;
}

const FILE = "coordinator.json";
const DOG_KEY = /^(?:\*|[\w-]{1,128})$/;

export const coordinatorSettingSchema = z.object({
  capabilities: z.enum(CAPABILITY_MODES).optional(),
  queue: z.record(z.string().regex(DOG_KEY), z.enum(QUEUE_MODES).nullable()).optional(),
}).strict();

export const OFF: CoordinatorSetting = { capabilities: "random", queue: {} };

export function readCoordinatorSetting(dataDir: string): CoordinatorSetting {
  const file = join(dataDir, FILE);
  if (!existsSync(file)) return OFF;
  try {
    const parsed = coordinatorSettingSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return OFF;
    return mergeCoordinatorSetting(OFF, parsed.data);
  } catch {
    return OFF;
  }
}

export function mergeCoordinatorSetting(current: CoordinatorSetting, change: z.infer<typeof coordinatorSettingSchema>): CoordinatorSetting {
  const queue = { ...current.queue };
  for (const [dog, mode] of Object.entries(change.queue ?? {})) {
    if (mode === null) delete queue[dog];
    else queue[dog] = mode;
  }
  return { capabilities: change.capabilities ?? current.capabilities, queue };
}

export function saveCoordinatorSetting(dataDir: string, setting: CoordinatorSetting): void {
  const file = join(dataDir, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(setting)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function queueModeFor(setting: CoordinatorSetting, dogId: string): QueueMode {
  return setting.queue[dogId] ?? setting.queue[EVERY_DOG] ?? "container";
}
