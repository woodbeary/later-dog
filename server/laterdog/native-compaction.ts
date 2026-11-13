import type { CompactionEvent } from "../../shared/runtime-events.ts";

export const HARNESS_COMPACTING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export interface HarnessCompactionSetting {
  harnessCompaction?: boolean;
}

export function harnessCompacts(driverKind: string, setting: HarnessCompactionSetting | undefined): boolean {
  return setting?.harnessCompaction !== false && HARNESS_COMPACTING_DRIVERS.has(driverKind);
}

export interface SessionRebuild {
  startsFresh: boolean;
  droppedFromReplay: number;
}

export function rebuildNeedsSummary(rebuild: SessionRebuild): boolean {
  return rebuild.startsFresh && rebuild.droppedFromReplay > 0;
}

export function codexCompactionEvent(phase: "started" | "completed", item: { type?: unknown } | undefined): CompactionEvent | null {
  if (item?.type !== "contextCompaction") return null;
  return phase === "started" ? { type: "session.compacting" } : { type: "session.compacted", ok: true, trigger: "auto" };
}
