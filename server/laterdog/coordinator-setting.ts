import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HISTORY_MODES, type HistoryMode } from "./history-writer.ts";

export const CAPABILITY_MODES = ["random", "signed"] as const;
export const QUEUE_MODES = ["container", "object"] as const;
export const DOG_PART_MODES = ["container", "object"] as const;
export const ADMISSION_MODES = ["container", "edge"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];
export type DogPartMode = (typeof DOG_PART_MODES)[number];

export { HISTORY_MODES, type HistoryMode };
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export type QueueMode = (typeof QUEUE_MODES)[number];
export const EVERY_DOG = "*";

export interface CoordinatorSetting {
  capabilities: CapabilityMode;
  queue: Record<string, QueueMode>;
  history: HistoryMode;
  routines: Record<string, DogPartMode>;
  inbox: Record<string, DogPartMode>;
  historyDogs: string[];
  admission: Record<string, AdmissionMode>;
}

const FILE = "coordinator.json";
const DOG_KEY = /^(?:\*|[\w-]{1,128})$/;

export const coordinatorSettingSchema = z.object({
  capabilities: z.enum(CAPABILITY_MODES).optional(),
  queue: z.record(z.string().regex(DOG_KEY), z.enum(QUEUE_MODES).nullable()).optional(),
  history: z.enum(HISTORY_MODES).optional(),
  routines: z.record(z.string().regex(DOG_KEY), z.enum(DOG_PART_MODES).nullable()).optional(),
  inbox: z.record(z.string().regex(DOG_KEY), z.enum(DOG_PART_MODES).nullable()).optional(),
  historyDogs: z.array(z.string().regex(DOG_KEY)).min(1).max(500).optional(),
  admission: z.record(z.string().regex(DOG_KEY), z.enum(ADMISSION_MODES).nullable()).optional(),
}).strict();

export const OFF: CoordinatorSetting = { capabilities: "random", queue: {}, history: "off", routines: {}, inbox: {}, historyDogs: [EVERY_DOG], admission: {} };

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

function mergeDogModes<Mode extends string>(current: Record<string, Mode>, change: Record<string, Mode | null> | undefined): Record<string, Mode> {
  const merged = { ...current };
  for (const [dog, mode] of Object.entries(change ?? {})) {
    if (mode === null) delete merged[dog];
    else merged[dog] = mode;
  }
  return merged;
}

export function mergeCoordinatorSetting(current: CoordinatorSetting, change: z.infer<typeof coordinatorSettingSchema>): CoordinatorSetting {
  return {
    capabilities: change.capabilities ?? current.capabilities,
    queue: mergeDogModes(current.queue, change.queue),
    history: change.history ?? current.history,
    routines: mergeDogModes(current.routines ?? {}, change.routines),
    inbox: mergeDogModes(current.inbox ?? {}, change.inbox),
    historyDogs: change.historyDogs ?? current.historyDogs ?? [EVERY_DOG],
    admission: mergeDogModes(current.admission ?? {}, change.admission),
  };
}

export function saveCoordinatorSetting(dataDir: string, setting: CoordinatorSetting): void {
  const file = join(dataDir, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(setting)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function queueModeFor(setting: CoordinatorSetting, dogId: string): QueueMode {
  return setting.queue[dogId] ?? setting.queue[EVERY_DOG] ?? "container";
}

export function dogPartModeFor(modes: Record<string, DogPartMode>, dogId: string): DogPartMode {
  return modes[dogId] ?? modes[EVERY_DOG] ?? "container";
}

export function historyCovers(setting: CoordinatorSetting, dogId: string | null): boolean {
  return setting.historyDogs.includes(EVERY_DOG) || (dogId !== null && setting.historyDogs.includes(dogId));
}

export function edgeAdmissionDogs(setting: CoordinatorSetting): string[] {
  return Object.entries(setting.admission ?? {}).filter(([, mode]) => mode === "edge").map(([dog]) => dog);
}
