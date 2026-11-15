export type HelperModelChoice = "same" | "lighter" | (string & {});

export type HelperModel = { kind: "inherit" } | { kind: "model"; model: string };

export const CLAUDE_SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";

const CLAUDE_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
type ClaudeTier = (typeof CLAUDE_TIERS)[number];

const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,126}(?:\[1m\])?$/i;
const OFFICIAL_CLAUDE_MODEL = /^claude-(haiku|sonnet|opus|fable)-[0-9][a-z0-9.-]*(?:\[1m\])?$/i;
const CLAUDE_ALIAS = /^(haiku|sonnet|opus|fable)(?:\[1m\])?$/i;

const INHERIT: HelperModel = { kind: "inherit" };

export function parseHelperModelChoice(raw: unknown): { ok: true; value: HelperModelChoice } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "helperModel must be \"same\", \"lighter\" or a model id" };
  const value = raw.trim();
  if (value === "same" || value === "lighter") return { ok: true, value };
  if (!MODEL_ID.test(value) || value === "inherit" || value === "default") {
    return { ok: false, error: "helperModel must be \"same\", \"lighter\" or a model id" };
  }
  return { ok: true, value };
}

export function claudeTier(model: string | null | undefined): ClaudeTier | null {
  const id = model?.trim().toLowerCase() ?? "";
  const match = OFFICIAL_CLAUDE_MODEL.exec(id) ?? CLAUDE_ALIAS.exec(id);
  return match ? (match[1] as ClaudeTier) : null;
}

const DEFAULT_HELPER_FLOOR: ClaudeTier = "sonnet";

function stepDown(tier: ClaudeTier, floor: ClaudeTier): HelperModel {
  const index = CLAUDE_TIERS.indexOf(tier);
  return index > Math.max(0, CLAUDE_TIERS.indexOf(floor)) ? { kind: "model", model: CLAUDE_TIERS[index - 1]! } : INHERIT;
}

export function helperModelFor(engine: string, model: string | null | undefined, choice: HelperModelChoice | undefined): HelperModel {
  if (choice === "same" || engine !== "claude") return INHERIT;
  const tier = claudeTier(model);
  if (!tier) return INHERIT;
  if (!choice) return stepDown(tier, DEFAULT_HELPER_FLOOR);
  if (choice === "lighter") return stepDown(tier, "haiku");
  return claudeTier(choice) ? { kind: "model", model: choice } : INHERIT;
}

export function claudeHelperEnvironment(
  model: string | null | undefined,
  choice: HelperModelChoice | undefined,
  options: { custom: boolean },
): Record<string, string> {
  if (options.custom) return {};
  const helper = helperModelFor("claude", model, choice);
  return helper.kind === "model" ? { [CLAUDE_SUBAGENT_MODEL_ENV]: helper.model } : {};
}
