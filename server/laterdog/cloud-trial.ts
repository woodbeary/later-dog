import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import {
  ComputersClient, INCLUDED_SERVICES, TRIAL_KEY, readCapped, savedTrial, serviceApi, trialKeyFile, trialStateFile, type IncludedService, type PlanInfo, type SavedTrial, type TrialView,
} from "./cloud-computers.ts";

export const DEFAULT_TRIAL_API = "https://cloud.later.dog/v1";

export type TrialStatus =
  | { state: "none" }
  | { state: "offered"; minutes: number; days: number; ai?: true }
  | { state: "pending"; url: string }
  | { state: "active"; minutes: number; minutesLeft: number; expiresAt: string; plan?: PlanInfo; planOffered?: true; ai?: true }
  | { state: "used_up"; minutes: number; expiresAt: string; plan?: PlanInfo; planOffered?: true; ai?: true }
  | { state: "ended"; planOffered?: true };

export interface TrialOptions { otherComputers: () => boolean; fetch?: typeof fetch }

const OFFER_TIMEOUT_MS = 15_000;
const MAX_OFFER_BYTES = 64 * 1024;
const offerBody = z.object({ offered: z.boolean(), minutes: z.number().int().min(1).max(600), days: z.number().int().min(1).max(90), included: z.array(z.string().max(32)).max(16).optional() });

const refused = (message: string) => Object.assign(new Error(message), { status: 409 });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const trialPage = (api: string, key: string) => `${new URL(api).origin}/trial?claim=${sha256(key)}`;

function trialApi(): string | null {
  const named = process.env.LATERDOG_TRIAL_API?.trim();
  if (named === "off") return null;
  const raw = named || DEFAULT_TRIAL_API;
  return raw ? serviceApi(raw) : null;
}

function readKey(): string | null {
  let key: string;
  try { key = readFileSync(trialKeyFile(), "utf8").trim(); } catch { return null; }
  return TRIAL_KEY.test(key) ? key : null;
}

const save = (trial: SavedTrial) => writeFileAtomic(trialStateFile(), `${JSON.stringify(trial)}\n`, { mode: 0o600 });

function forget(): void {
  rmSync(trialKeyFile(), { force: true });
  rmSync(trialStateFile(), { force: true });
}

function end(saved: SavedTrial): void {
  save({ api: saved.api, confirmed: true, ended: true });
  rmSync(trialKeyFile(), { force: true });
}

const client = (saved: SavedTrial, options: TrialOptions) =>
  new ComputersClient({ api: saved.api, keyFile: trialKeyFile(), source: "trial" }, { fetch: options.fetch });

const extras = (trial: TrialView) => ({
  ...(trial.plan ? { plan: trial.plan } : {}),
  ...(trial.planOffered ? { planOffered: true as const } : {}),
  ...(trial.included?.includes("ai") ? { ai: true as const } : {}),
});

const view = (trial: TrialView): TrialStatus => trial.state === "active"
  ? { state: "active", minutes: trial.minutes, minutesLeft: trial.minutesLeft, expiresAt: trial.expiresAt, ...extras(trial) }
  : { state: "used_up", minutes: trial.minutes, expiresAt: trial.expiresAt, ...extras(trial) };

const PLAN_OPEN_TTL_MS = 10 * 60_000;
let planOpenCache: { api: string; at: number; open: boolean } | null = null;

export const planOfferedNow = (): boolean => planOpenCache?.open === true;

async function planOpen(options: TrialOptions): Promise<boolean> {
  const api = savedTrial()?.api ?? trialApi();
  if (!api) return false;
  if (planOpenCache?.api === api && Date.now() - planOpenCache.at < PLAN_OPEN_TTL_MS) return planOpenCache.open;
  const open = await askPlanOpen(api, options);
  planOpenCache = { api, at: Date.now(), open };
  return open;
}

async function askPlanOpen(api: string, options: TrialOptions): Promise<boolean> {
  try {
    const response = await (options.fetch ?? fetch)(`${api}/trials`, {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(OFFER_TIMEOUT_MS),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return false; }
    const body = z.object({ planOffered: z.literal(true).optional() }).safeParse(JSON.parse((await readCapped(response, MAX_OFFER_BYTES, () => new Error("too large"))).toString("utf8")));
    return body.success && body.data.planOffered === true;
  } catch { return false; }
}

const finished = async (options: TrialOptions): Promise<TrialStatus> => {
  if (options.otherComputers()) return { state: "none" };
  return (await planOpen(options)) ? { state: "ended", planOffered: true } : { state: "ended" };
};

async function offer(options: TrialOptions): Promise<TrialStatus> {
  if (options.otherComputers()) return { state: "none" };
  const api = trialApi();
  if (!api) return { state: "none" };
  try {
    const response = await (options.fetch ?? fetch)(`${api}/trials`, {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(OFFER_TIMEOUT_MS),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return { state: "none" }; }
    const body = offerBody.safeParse(JSON.parse((await readCapped(response, MAX_OFFER_BYTES, () => new Error("too large"))).toString("utf8")));
    if (!body.success || !body.data.offered) return { state: "none" };
    const ai = body.data.included?.includes("ai") === true;
    return { state: "offered", minutes: body.data.minutes, days: body.data.days, ...(ai ? { ai: true as const } : {}) };
  } catch { return { state: "none" }; }
}

async function current(options: TrialOptions): Promise<TrialStatus> {
  const saved = savedTrial();
  if (!saved) return offer(options);
  const key = saved.ended ? null : readKey();
  if (key) {
    const trial = await client(saved, options).trial();
    if (trial) {
      const included = trial.included;
      if (!saved.confirmed || JSON.stringify(saved.included ?? null) !== JSON.stringify(included ?? null)) {
        save({ api: saved.api, confirmed: true, ...(included ? { included } : {}) });
      }
      return view(trial);
    }
    if (!saved.confirmed) return { state: "pending", url: trialPage(saved.api, key) };
  }
  if (!saved.confirmed) { forget(); return offer(options); }
  if (!saved.ended) end(saved);
  return finished(options);
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export const trialStatus = (options: TrialOptions): Promise<TrialStatus> => serial(() => current(options));

export function startTrial(options: TrialOptions): Promise<TrialStatus> {
  return serial(async () => {
    const saved = savedTrial();
    if (saved?.confirmed) throw refused(saved.ended ? "This installation has used its free trial" : "The free trial has already started");
    const pending = saved ? readKey() : null;
    if (saved && pending) return { state: "pending", url: trialPage(saved.api, pending) };
    if (options.otherComputers()) throw refused("Cloud computers are already set up here");
    const api = trialApi();
    if (!api) throw refused("Free trials are not offered by this version of later.dog");
    const key = `ldt_${randomBytes(32).toString("base64url")}`;
    writeFileAtomic(trialKeyFile(), `${key}\n`, { mode: 0o600 });
    save({ api });
    return { state: "pending", url: trialPage(api, key) };
  });
}

const startBody = z.object({ included: z.array(z.string().max(32)).max(16).optional() });

/** A new installation's free trial, claimed by the app itself so its first
 * dog can answer at once. Nothing is saved unless the service accepts it, so
 * a refusal (one trial per network, today's trials taken) leaves the manual
 * Try free path exactly as it was. */
export function autoStartTrial(options: TrialOptions): Promise<boolean> {
  return serial(async () => {
    if (savedTrial() || options.otherComputers()) return false;
    const api = trialApi();
    if (!api) return false;
    const key = `ldt_${randomBytes(32).toString("base64url")}`;
    const claim = createHash("sha256").update(key).digest("hex");
    try {
      const response = await (options.fetch ?? fetch)(`${api}/trials/start`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ claim }),
        redirect: "error",
        signal: AbortSignal.timeout(OFFER_TIMEOUT_MS),
      });
      if (response.status !== 200 && response.status !== 201) {
        await response.body?.cancel().catch(() => {});
        return false;
      }
      const body = startBody.safeParse(JSON.parse((await readCapped(response, MAX_OFFER_BYTES, () => new Error("too large"))).toString("utf8")));
      const included = body.success ? body.data.included?.filter((name): name is IncludedService => (INCLUDED_SERVICES as readonly string[]).includes(name)) : undefined;
      writeFileAtomic(trialKeyFile(), `${key}\n`, { mode: 0o600 });
      save({ api, confirmed: true, ...(included?.length ? { included } : {}) });
      return true;
    } catch {
      return false;
    }
  });
}

export function endTrial(options: TrialOptions): Promise<TrialStatus> {
  return serial(async () => {
    const saved = savedTrial();
    if (saved && !saved.confirmed) forget();
    else if (saved && !saved.ended) {
      if (readKey()) await client(saved, options).endTrial();
      end(saved);
    }
    return current(options);
  });
}

export type PlanCheckout = { state: "checkout"; url: string } | TrialStatus;

export function startPlan(options: TrialOptions): Promise<PlanCheckout> {
  return serial(async () => {
    const api = savedTrial()?.api ?? trialApi();
    if (!api) throw refused("later.dog Cloud is not offered by this version of later.dog");
    let key = readKey();
    if (!key) {
      key = `ldt_${randomBytes(32).toString("base64url")}`;
      writeFileAtomic(trialKeyFile(), `${key}\n`, { mode: 0o600 });
      save({ api });
    }
    const checkout = await client({ api }, options).planCheckout();
    if ("url" in checkout) return { state: "checkout", url: checkout.url };
    return current(options);
  });
}

export function cancelPlan(options: TrialOptions): Promise<TrialStatus> {
  return serial(async () => {
    const saved = savedTrial();
    if (!saved || !readKey()) throw refused("There is no later.dog Cloud plan here");
    await client(saved, options).cancelPlan();
    return current(options);
  });
}
