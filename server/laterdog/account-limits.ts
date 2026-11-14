export const SETUP_STOP = "setup";

export interface LimitedRest {
  until: string;
  kind?: string;
  model?: string;
  estimated?: boolean;
}

export type LimitKind = "session" | "week" | "model" | "signIn" | "other";

export interface LimitHit {
  limit: LimitKind;
  model?: string;
  label: string;
  until: string;
  estimated?: true;
}

const MODEL_NAMES: Readonly<Record<string, string>> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const ALLOWED_MODELS_WEEK = "seven_day_overage_included";
const ALLOWED_MODEL_BY_DEFAULT = "fable";
const MODEL_KEY = "#";

const OTHER_LABELS: Readonly<Record<string, string>> = { daily: "Daily limit", monthly: "Monthly limit", overage: "Usage credit limit" };

const own = (names: Readonly<Record<string, string>>, key: string | undefined) => key !== undefined && Object.hasOwn(names, key) ? names[key] : undefined;

export function modelFamily(model: string): string {
  const lower = model.trim().toLowerCase();
  const words = lower.split(/[^a-z]+/);
  return Object.keys(MODEL_NAMES).find((family) => words.includes(family)) ?? lower.replace(/\[[^\]]*\]$/, "");
}

export function modelLimitName(kind: string | undefined, ranModel: string | undefined): string | undefined {
  if (!kind) return undefined;
  const named = own(MODEL_NAMES, kind) ?? own(MODEL_NAMES, kind.replace(/^(?:seven_day|five_hour)_/, ""));
  if (named) return named;
  if (kind !== ALLOWED_MODELS_WEEK) return undefined;
  const family = ranModel?.trim() ? modelFamily(ranModel) : ALLOWED_MODEL_BY_DEFAULT;
  return own(MODEL_NAMES, family) ?? ranModel!.trim();
}

export function restModel(rest: Pick<LimitedRest, "kind" | "model">): string | undefined {
  return rest.model ?? modelLimitName(rest.kind, undefined);
}

export function sameModel(a: string, b: string): boolean {
  return modelFamily(a) === modelFamily(b);
}

export function modelRestKey(instanceId: string, model: string): string {
  return `${instanceId}${MODEL_KEY}${modelFamily(model)}`;
}

export function restOwner(key: string): string {
  const at = key.indexOf(MODEL_KEY);
  return at === -1 ? key : key.slice(0, at);
}

export function limitHit(rest: LimitedRest): LimitHit {
  const estimated = rest.estimated ? { estimated: true as const } : {};
  const model = restModel(rest);
  if (model) return { limit: "model", model, label: `${model} ${rest.kind === "session" ? "5-hour" : "weekly"} limit`, until: rest.until, ...estimated };
  if (rest.kind === "session") return { limit: "session", label: "5-hour limit", until: rest.until, ...estimated };
  if (rest.kind === "weekly") return { limit: "week", label: "Weekly limit", until: rest.until, ...estimated };
  if (rest.kind === SETUP_STOP) return { limit: "signIn", label: "Sign-in needed", until: rest.until, ...estimated };
  return { limit: "other", label: own(OTHER_LABELS, rest.kind) ?? "Usage limit", until: rest.until, ...estimated };
}

export function limitsHit(rests: readonly LimitedRest[]): LimitHit[] {
  const hits = rests.map(limitHit);
  const whole = hits.filter((hit) => hit.limit !== "model").sort((a, b) => b.until.localeCompare(a.until));
  const models = hits.filter((hit) => hit.limit === "model").sort((a, b) => a.until.localeCompare(b.until));
  return [...whole, ...models];
}
