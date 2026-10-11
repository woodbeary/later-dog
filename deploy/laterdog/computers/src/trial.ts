import { MINUTE, bounded } from "./idle";

export const DAY = 24 * 60 * MINUTE;
export const TRIAL_TOKEN = /^ldt_[A-Za-z0-9_-]{43}$/;
export const TRIAL_CLAIM = /^[0-9a-f]{64}$/;
export const TRIAL_ACTION = "trial";
export const TRIAL_FORM_MAX_BYTES = 8192;
export const TURNSTILE_TOKEN_MAX_CHARS = 2048;
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TrialEnv {
  TRIALS_ENABLED?: string;
  TRIAL_MINUTES?: string;
  TRIAL_DAYS?: string;
  TRIALS_PER_DAY?: string;
  TRIAL_IDLE_SLEEP_MINUTES?: string;
  TRIAL_COUNTRIES?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TRIAL_NETWORK_KEY?: string;
}

export interface TrialPolicy {
  enabled: boolean;
  siteKey: string;
  limitMs: number;
  windowMs: number;
  perDay: number;
  idleSleepMs: number;
  countries: string[];
}

export interface TrialRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  limitMs: number;
  usedMs: number;
}

export interface TrialView {
  state: "active" | "used_up";
  minutes: number;
  minutesLeft: number;
  expiresAt: string;
}

export function trialPolicy(env: TrialEnv): TrialPolicy {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const perDay = Math.floor(bounded(env.TRIALS_PER_DAY, 20, 0, 10_000));
  const configured = siteKey !== "" && Boolean(env.TURNSTILE_SECRET_KEY?.trim()) && Boolean(env.TRIAL_NETWORK_KEY?.trim());
  return {
    enabled: env.TRIALS_ENABLED?.trim() === "true" && configured && perDay > 0,
    siteKey,
    limitMs: Math.round(bounded(env.TRIAL_MINUTES, 30, 5, 600)) * MINUTE,
    windowMs: Math.round(bounded(env.TRIAL_DAYS, 7, 1, 90)) * DAY,
    perDay,
    idleSleepMs: Math.round(bounded(env.TRIAL_IDLE_SLEEP_MINUTES, 5, 1, 60)) * MINUTE,
    countries: [...new Set((env.TRIAL_COUNTRIES ?? "").split(",").map((code) => code.trim().toUpperCase()))].filter((code) => /^[A-Z]{2}$/.test(code)),
  };
}

export function trialOffer(policy: TrialPolicy): { offered: boolean; minutes: number; days: number } {
  return { offered: policy.enabled, minutes: Math.round(policy.limitMs / MINUTE), days: Math.round(policy.windowMs / DAY) };
}

export function trialView(trial: TrialRecord): TrialView {
  const leftMs = Math.max(0, trial.limitMs - trial.usedMs);
  return {
    state: leftMs >= MINUTE ? "active" : "used_up",
    minutes: Math.round(trial.limitMs / MINUTE),
    minutesLeft: Math.floor(leftMs / MINUTE),
    expiresAt: new Date(trial.expiresAt).toISOString(),
  };
}

export function trialListing(id: string): string {
  return `trial:${id}`;
}

export function allowedCountry(policy: TrialPolicy, country: string | undefined): boolean {
  return policy.countries.length === 0 || (country !== undefined && policy.countries.includes(country.toUpperCase()));
}

export type TrialForm = { ok: true; claim: string; token: string } | { ok: false; problem: "claim" | "check" };

export function parseTrialForm(text: string): TrialForm {
  const form = new URLSearchParams(text);
  const claim = form.get("claim") ?? "";
  if (!TRIAL_CLAIM.test(claim)) return { ok: false, problem: "claim" };
  const token = form.get("cf-turnstile-response") ?? "";
  if (token.length === 0 || token.length > TURNSTILE_TOKEN_MAX_CHARS) return { ok: false, problem: "check" };
  return { ok: true, claim, token };
}

function ipv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return undefined;
  return parts.map(Number);
}

function hextets(part: string, last: boolean): number[] | undefined {
  if (part === "") return [];
  const pieces = part.split(":");
  const out: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (last && index === pieces.length - 1 && piece.includes(".")) {
      const octets = ipv4(piece);
      if (!octets) return undefined;
      out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    } else if (/^[0-9A-Fa-f]{1,4}$/.test(piece)) {
      out.push(parseInt(piece, 16));
    } else {
      return undefined;
    }
  }
  return out;
}

function ipv6(text: string): number[] | undefined {
  if (text.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(text)) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  if (halves.length === 1) {
    const all = hextets(text, true);
    return all?.length === 8 ? all : undefined;
  }
  const head = hextets(halves[0]!, false);
  const tail = hextets(halves[1]!, true);
  if (!head || !tail || head.length + tail.length > 7) return undefined;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

export function networkOf(raw: string | null | undefined): string | undefined {
  const text = raw?.trim() ?? "";
  const v4 = ipv4(text);
  if (v4) return `4:${v4.join(".")}`;
  const v6 = ipv6(text);
  if (!v6) return undefined;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return `4:${[v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255].join(".")}`;
  }
  return `6:${v6
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

export async function networkDigest(secret: string, network: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`laterdog-trial-network\n${network}`)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function turnstileVerdict(outcome: unknown, expected: { hostname: string; cdata: string }): boolean {
  if (typeof outcome !== "object" || outcome === null) return false;
  const result = outcome as Record<string, unknown>;
  return result.success === true && result.hostname === expected.hostname && result.action === TRIAL_ACTION && result.cdata === expected.cdata;
}

export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  ip?: string;
  hostname: string;
  cdata: string;
}): Promise<"passed" | "failed" | "unavailable"> {
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.ip) body.set("remoteip", input.ip);
  let outcome: unknown;
  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return "unavailable";
    }
    outcome = await response.json();
  } catch {
    return "unavailable";
  }
  return turnstileVerdict(outcome, input) ? "passed" : "failed";
}
