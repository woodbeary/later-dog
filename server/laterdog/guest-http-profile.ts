import type { AnyProviderDriver, DriverCreateInput } from "../contracts.ts";
import { GrokDriver, type GrokConfig } from "../drivers/grok.ts";
import { OpenAICompatDriver, type OpenAICompatConfig } from "../drivers/openai-compat.ts";
import { INCLUDED_AI_DRIVER, INCLUDED_GROK_DRIVER, includedGuestDriver } from "./included-ai.ts";
import { trialAi } from "./included-trial.ts";
import type { GuestProviderProfile } from "./guest-provider-types.ts";

const included = (kind: string) => kind === INCLUDED_AI_DRIVER || kind === INCLUDED_GROK_DRIVER;

export function guestHttpDriver(kind: string, input: DriverCreateInput<unknown>): AnyProviderDriver | null {
  if (kind === GrokDriver.driverKind) return GrokDriver;
  if (kind === OpenAICompatDriver.driverKind) return OpenAICompatDriver;
  if (!included(kind)) return null;
  const credentials = input.config as { api: string; token: string };
  return includedGuestDriver(kind, credentials.api, () => credentials.token);
}

async function chatGrant(api: string): Promise<string> {
  const account = trialAi();
  if (!account || account.api !== api) throw new Error("The selected included model account has changed.");
  const response = await fetch(api + "/grant", { method: "POST", redirect: "error", headers: { authorization: "Bearer " + account.token }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("The included model could not authorize this dog's computer (" + response.status + ").");
  const data = await response.json() as { token?: unknown };
  if (typeof data.token !== "string" || !/^chat1\.[a-f0-9]{64}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/.test(data.token)) throw new Error("Invalid included model grant.");
  return data.token;
}

export async function guestHttpProfile(kind: string, input: DriverCreateInput<unknown>): Promise<GuestProviderProfile | null> {
  if (included(kind)) {
    const account = trialAi();
    if (!account) throw new Error("The included model is unavailable on this account.");
    const token = await chatGrant(account.api);
    const renew = async () => {
      const next = await chatGrant(account.api);
      if (next.split(".")[1] !== token.split(".")[1]) throw new Error("The selected included model account has changed.");
      return next;
    };
    return { input: { ...input, environment: {}, config: { api: account.api, token } }, renew };
  }
  if (kind !== GrokDriver.driverKind && kind !== OpenAICompatDriver.driverKind) return null;
  const config = input.config as GrokConfig | OpenAICompatConfig;
  const key = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
  return { input: { ...input, environment: { [config.apiKeyEnv]: key } } };
}
