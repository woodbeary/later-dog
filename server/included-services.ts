import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";
import { trialDecider, trialVoice } from "./laterdog/included-trial.ts";

export const BOAT_API_DEFAULT = "https://ascii.dev/api/box/v1";
export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";
export const INCLUDED_TOKEN_ENV = ["LATERDOG_CLOUD_BOAT_TOKEN", "LATERDOG_CLOUD_VOICE_TOKEN", "LATERDOG_CLOUD_DECIDER_TOKEN"] as const;

export interface ServiceCredential {
  token: string;
  api: string;
  included: boolean;
}

interface Included {
  boat: ServiceCredential | null;
  voice: ServiceCredential | null;
  decider: ServiceCredential | null;
}

function includedService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const api = url?.trim().replace(/\/+$/, "");
  const secret = token?.trim();
  return api && secret ? { token: secret, api, included: true } : null;
}

const includedFrom = (env: NodeJS.ProcessEnv): Included => ({
  boat: includedService(env.LATERDOG_CLOUD_BOAT_URL, env.LATERDOG_CLOUD_BOAT_TOKEN),
  voice: includedService(env.LATERDOG_CLOUD_VOICE_URL, env.LATERDOG_CLOUD_VOICE_TOKEN),
  decider: includedService(env.LATERDOG_CLOUD_DECIDER_URL, env.LATERDOG_CLOUD_DECIDER_TOKEN),
});

let held: Included | null = null;

export function holdIncludedServices(env: NodeJS.ProcessEnv = process.env): void {
  held = includedFrom(env);
  for (const name of INCLUDED_TOKEN_ENV) delete env[name];
}

function resolve(own: string | undefined, providerApi: string, included: ServiceCredential | null): ServiceCredential | null {
  if (own) {
    if (included && own === included.token) return included;
    return { token: own, api: providerApi, included: false };
  }
  return included;
}

export const boatProviderApi = (env: NodeJS.ProcessEnv = process.env): string => env.LATERDOG_BOX_API || BOAT_API_DEFAULT;
export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LATERDOG_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

export function boatCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, boatProviderApi(env), (held ?? includedFrom(env)).boat);
}

export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, elevenLabsProviderApi(env), (held ?? includedFrom(env)).voice ?? trialVoice());
}

export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceCredential | null {
  return resolve(own?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, (held ?? includedFrom(env)).decider ?? trialDecider());
}
