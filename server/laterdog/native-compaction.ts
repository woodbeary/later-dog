import type { CompactionEvent } from "../../shared/runtime-events.ts";

export const HARNESS_COMPACTING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export interface HarnessCompactionSetting {
  harnessCompaction?: boolean;
}

export function envSwitchedOn(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase() ?? "";
  return text !== "" && text !== "0" && text !== "false" && text !== "no" && text !== "off";
}

export function harnessCompacts(driverKind: string, setting: HarnessCompactionSetting | undefined): boolean {
  return setting?.harnessCompaction !== false && HARNESS_COMPACTING_DRIVERS.has(driverKind);
}

export interface CompactionSigns {
  switchedOff?: boolean;
  managed?: boolean;
}

export interface ChatCompactionFacts {
  driverKind: string;
  setting?: HarnessCompactionSetting;
  signs?: CompactionSigns;
  modelKnown: boolean;
}

export function engineWillCompact(facts: ChatCompactionFacts): boolean {
  if (!harnessCompacts(facts.driverKind, facts.setting)) return false;
  if (facts.signs?.switchedOff) return false;
  if (facts.driverKind === "codex" && (facts.signs?.managed || !facts.modelKnown)) return false;
  return true;
}

const COMPACTION_OFF_SWITCHES = ["DISABLE_AUTO_COMPACT", "DISABLE_COMPACT"] as const;

export function claudeCompactionSwitchedOff(env: NodeJS.ProcessEnv, inheritedSettings?: unknown): boolean {
  if (COMPACTION_OFF_SWITCHES.some((name) => envSwitchedOn(env[name]))) return true;
  if (!inheritedSettings || typeof inheritedSettings !== "object") return false;
  const settings = inheritedSettings as { autoCompactEnabled?: unknown; env?: Record<string, unknown> };
  if (settings.autoCompactEnabled === false) return true;
  return COMPACTION_OFF_SWITCHES.some((name) => typeof settings.env?.[name] === "string" && envSwitchedOn(settings.env[name] as string));
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
