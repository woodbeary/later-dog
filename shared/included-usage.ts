export const USAGE_KINDS = [
  "transcribe_seconds",
  "voice_chars",
  "elevenlabs_chars",
  "ai_tokens",
  "grok_tokens",
  "anthropic_tokens",
  "completions",
  "decisions",
  "tool_decisions",
  "screen_checks",
] as const;
export type UsageKind = typeof USAGE_KINDS[number];

export const SPEND_PROVIDERS = ["elevenlabs", "cloudflare", "xai", "anthropic"] as const;
export type SpendProvider = typeof SPEND_PROVIDERS[number];

export const SPEND_SERVICES = ["dictation", "voice", "chat", "typing", "decisions"] as const;
export type SpendService = typeof SPEND_SERVICES[number];

export const INSTALL_TIERS = ["trial", "home", "plan", "owner"] as const;
export type InstallTier = typeof INSTALL_TIERS[number];

export const USAGE_HISTORY_DAYS = 90;
export const GRANT_MAX_USD = 10_000_000;
export const GRANT_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type UsageAmounts = Partial<Record<UsageKind, number>>;

export interface IncludedUsageDay {
  day: string;
  used: UsageAmounts;
  micros?: number;
}

export interface IncludedUsage {
  owner: boolean;
  tier: InstallTier | null;
  today: string;
  days: IncludedUsageDay[];
  limits: UsageAmounts | null;
}

export interface Grant {
  provider: SpendProvider;
  usd: number;
  since: string;
}

export interface GrantSpend extends Grant {
  spentMicros: number;
}

export interface ServiceSpend {
  service: SpendService;
  units: number;
  micros: number;
}

export interface TopInstall {
  label: string;
  tier: InstallTier | null;
  owner: boolean;
  micros: number;
  services: ServiceSpend[];
}

export interface OwnerReport {
  today: string;
  days: string[];
  usage: { day: string; kind: UsageKind; used: number }[];
  active: { day: string; installs: number }[];
  activeInstalls: number;
  spend: { day: string; service: SpendService; provider: SpendProvider; units: number; micros: number }[];
  top: TopInstall[];
  grants: GrantSpend[];
}

export function grantProblem(grants: readonly Grant[]): "count" | "provider" | "amount" | "date" | "duplicate" | null {
  if (grants.length > SPEND_PROVIDERS.length) return "count";
  const seen = new Set<string>();
  for (const grant of grants) {
    if (!(SPEND_PROVIDERS as readonly string[]).includes(grant.provider)) return "provider";
    if (!Number.isFinite(grant.usd) || grant.usd <= 0 || grant.usd > GRANT_MAX_USD) return "amount";
    if (!GRANT_DAY.test(grant.since) || Number.isNaN(Date.parse(`${grant.since}T00:00:00Z`))) return "date";
    if (seen.has(grant.provider)) return "duplicate";
    seen.add(grant.provider);
  }
  return null;
}
