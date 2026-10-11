import { readFileSync } from "node:fs";
import { TRIAL_KEY, savedTrial, trialKeyFile, type IncludedService } from "./cloud-computers.ts";

export interface IncludedTrial { token: string; api: string; included: true }

function liveTrial(service: IncludedService): { key: string; api: string } | null {
  const saved = savedTrial();
  if (!saved?.confirmed || saved.ended) return null;
  if (saved.included ? !saved.included.includes(service) : service !== "decisions") return null;
  let key: string;
  try { key = readFileSync(trialKeyFile(), "utf8").trim(); } catch { return null; }
  return TRIAL_KEY.test(key) ? { key, api: saved.api } : null;
}

export function trialDecider(): IncludedTrial | null {
  const trial = liveTrial("decisions");
  if (!trial || !trial.api.endsWith("/v1")) return null;
  return { token: trial.key, api: trial.api.slice(0, -"/v1".length), included: true };
}

export function trialVoice(): IncludedTrial | null {
  const trial = liveTrial("voice");
  return trial ? { token: trial.key, api: `${trial.api}/voice`, included: true } : null;
}

export function trialAi(): IncludedTrial | null {
  const trial = liveTrial("ai");
  return trial ? { token: trial.key, api: `${trial.api}/ai`, included: true } : null;
}
