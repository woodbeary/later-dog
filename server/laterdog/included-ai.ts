import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "../drivers/openai-chat.ts";
import { savedTrial } from "./cloud-computers.ts";
import { planOfferedNow } from "./cloud-trial.ts";
import { trialAi } from "./included-trial.ts";

export const INCLUDED_AI_DRIVER = "laterdogAi";
export const INCLUDED_AI_INSTANCE = "laterdogAi";
const FALLBACK_URL = "https://cloud.later.dog/v1/ai";
const MODELS = { default: "later-dog", options: [{ id: "later-dog", label: "later.dog AI", contextWindow: 256_000 }] };
const NOT_STARTED = "Start the free trial to use later.dog AI.";
const ENDED = "Your free later.dog AI has ended. Sign in to Claude or ChatGPT to keep going.";
const ENDED_WITH_PLAN = "Your free later.dog AI has ended. Sign in to Claude or ChatGPT, or keep going on later.dog Cloud in Settings, Computer.";
const ended = () => (planOfferedNow() ? ENDED_WITH_PLAN : ENDED);
const DAILY = "You've used today's free later.dog AI. It comes back tomorrow, or sign in to Claude or ChatGPT to keep going now.";
const BUSY = "later.dog AI is busy right now. Try again in a minute, or sign in to Claude or ChatGPT.";
const TOO_LARGE = "That was too much for later.dog AI to take in at once, most likely a large screenshot. Try again, or start a new chat.";

export function includedAiError(status: number, body: string): string | undefined {
  let code = "";
  try { code = String((JSON.parse(body) as { error?: { code?: unknown } }).error?.code ?? ""); } catch { code = ""; }
  if (status === 401) return ended();
  if (status === 413) return TOO_LARGE;
  if (status === 429 && code === "daily_limit") return DAILY;
  if (status === 429 || status === 503 || status === 502) return BUSY;
  return undefined;
}

const notReady = () => (savedTrial()?.ended ? ended() : NOT_STARTED);

export const IncludedAiDriver: ProviderDriver<Record<string, never>> = {
  driverKind: INCLUDED_AI_DRIVER,
  metadata: { displayName: "later.dog AI", supportsMultipleInstances: false },
  models: MODELS,
  decodeConfig: () => ({}),
  defaultConfig: () => ({}),

  async create(input) {
    return createOpenAIChatRuntime({
      input,
      driverKind: INCLUDED_AI_DRIVER,
      apiKey: () => trialAi()?.token ?? "",
      apiUrl: trialAi()?.api ?? FALLBACK_URL,
      models: () => MODELS,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "later.dog AI",
      errorText: includedAiError,
      missingKeyError: notReady(),
      unavailableReason: notReady(),
      timeoutMs: 120_000,
      generateModel: () => MODELS.default,
      computerUse: true,
      nudgeAnnouncedAction: true,
      nativeLog: {
        source: "laterdog.ai.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};
