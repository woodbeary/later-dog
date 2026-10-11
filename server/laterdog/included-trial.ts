import { readFileSync } from "node:fs";
import { TRIAL_KEY, savedTrial, trialKeyFile } from "./cloud-computers.ts";

export interface IncludedTrial { token: string; api: string; included: true }

function liveTrial(): { key: string; api: string } | null {
  const saved = savedTrial();
  if (!saved?.confirmed || saved.ended) return null;
  let key: string;
  try { key = readFileSync(trialKeyFile(), "utf8").trim(); } catch { return null; }
  return TRIAL_KEY.test(key) ? { key, api: saved.api } : null;
}

export function trialDecider(): IncludedTrial | null {
  const trial = liveTrial();
  if (!trial || !trial.api.endsWith("/v1")) return null;
  return { token: trial.key, api: trial.api.slice(0, -"/v1".length), included: true };
}

export function trialVoice(): IncludedTrial | null {
  const trial = liveTrial();
  return trial ? { token: trial.key, api: `${trial.api}/voice`, included: true } : null;
}
