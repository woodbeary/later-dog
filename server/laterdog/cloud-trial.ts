import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import {
  ComputersClient, TRIAL_KEY, readCapped, savedTrial, serviceApi, trialKeyFile, trialStateFile, type SavedTrial, type TrialView,
} from "./cloud-computers.ts";

export const DEFAULT_TRIAL_API = "";

export type TrialStatus =
  | { state: "none" }
  | { state: "offered"; minutes: number; days: number }
  | { state: "pending"; url: string }
  | { state: "active"; minutes: number; minutesLeft: number; expiresAt: string }
  | { state: "used_up"; minutes: number; expiresAt: string }
  | { state: "ended" };

export interface TrialOptions { otherComputers: () => boolean; fetch?: typeof fetch }

const OFFER_TIMEOUT_MS = 15_000;
const MAX_OFFER_BYTES = 64 * 1024;
const offerBody = z.object({ offered: z.boolean(), minutes: z.number().int().min(1).max(600), days: z.number().int().min(1).max(90) });

const refused = (message: string) => Object.assign(new Error(message), { status: 409 });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const trialPage = (api: string, key: string) => `${new URL(api).origin}/trial?claim=${sha256(key)}`;

function trialApi(): string | null {
  const raw = process.env.LATERDOG_TRIAL_API?.trim() || DEFAULT_TRIAL_API;
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

const view = (trial: TrialView): TrialStatus => trial.state === "active"
  ? { state: "active", minutes: trial.minutes, minutesLeft: trial.minutesLeft, expiresAt: trial.expiresAt }
  : { state: "used_up", minutes: trial.minutes, expiresAt: trial.expiresAt };

const finished = (options: TrialOptions): TrialStatus => options.otherComputers() ? { state: "none" } : { state: "ended" };

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
    return body.success && body.data.offered ? { state: "offered", minutes: body.data.minutes, days: body.data.days } : { state: "none" };
  } catch { return { state: "none" }; }
}

async function current(options: TrialOptions): Promise<TrialStatus> {
  const saved = savedTrial();
  if (!saved) return offer(options);
  const key = saved.ended ? null : readKey();
  if (key) {
    const trial = await client(saved, options).trial();
    if (trial) {
      if (!saved.confirmed) save({ api: saved.api, confirmed: true });
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
