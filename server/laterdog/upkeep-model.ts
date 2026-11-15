const CLAUDE_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
type ClaudeTier = (typeof CLAUDE_TIERS)[number];

const OFFICIAL_CLAUDE_MODEL = /^claude-(haiku|sonnet|opus|fable)-[0-9][a-z0-9.-]*(?:\[1m\])?$/i;
const CLAUDE_ALIAS = /^(haiku|sonnet|opus|fable)(?:\[1m\])?$/i;

const UPKEEP_FLOOR: ClaudeTier = "sonnet";

function tierOf(model: string | null | undefined): ClaudeTier | null {
  const id = model?.trim().toLowerCase() ?? "";
  const match = OFFICIAL_CLAUDE_MODEL.exec(id) ?? CLAUDE_ALIAS.exec(id);
  return match ? (match[1] as ClaudeTier) : null;
}

export function upkeepModelFor(engine: string, model: string | null | undefined): string | null {
  if (engine !== "claude") return null;
  const tier = tierOf(model);
  if (!tier) return null;
  const index = CLAUDE_TIERS.indexOf(tier);
  return index > CLAUDE_TIERS.indexOf(UPKEEP_FLOOR) ? CLAUDE_TIERS[index - 1]! : null;
}

export function memoryWriterModel(driverKind: string, model: string | null | undefined, options: { custom: boolean }): string | null | undefined {
  if (options.custom) return model;
  return upkeepModelFor(driverKind === "claudeAgent" ? "claude" : driverKind, model) ?? model;
}
