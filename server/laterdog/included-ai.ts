import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "../drivers/openai-chat.ts";
import { savedTrial } from "./cloud-computers.ts";
import { planOfferedNow } from "./cloud-trial.ts";
import { trialAi } from "./included-trial.ts";

export const INCLUDED_AI_DRIVER = "laterdogAi";
export const INCLUDED_AI_INSTANCE = "laterdogAi";
export const INCLUDED_GROK_DRIVER = "laterdogGrok";
export const INCLUDED_GROK_INSTANCE = "laterdogGrok";
export const INCLUDED_AI_INSTANCES: readonly string[] = [INCLUDED_AI_INSTANCE, INCLUDED_GROK_INSTANCE];
const FALLBACK_URL = "https://cloud.later.dog/v1/ai";
export const INCLUDED_CONTEXT_WINDOW = 256_000;
export const INCLUDED_BACKGROUND_MODEL = "kimi-k2.6";
export const INCLUDED_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: INCLUDED_CONTEXT_WINDOW }],
};
export const INCLUDED_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: INCLUDED_CONTEXT_WINDOW },
    { id: "grok-4.6", label: "Grok 4.6", contextWindow: INCLUDED_CONTEXT_WINDOW },
  ],
};
const INCLUDED_CATALOGS: Readonly<Record<string, ModelCatalog>> = {
  [INCLUDED_AI_INSTANCE]: INCLUDED_CLAUDE_MODELS,
  [INCLUDED_GROK_INSTANCE]: INCLUDED_GROK_MODELS,
};

export function offeredIncludedModel(models: ModelCatalog, model: string): string {
  return models.options.some((option) => option.id === model) ? model : models.default;
}

export function includedSelectionNow<T extends { instanceId: string; model: string }>(selection: T): T {
  const models = INCLUDED_CATALOGS[selection.instanceId];
  if (!models) return selection;
  const model = offeredIncludedModel(models, selection.model);
  return model === selection.model ? selection : { ...selection, model };
}

const NOT_STARTED = "Start the free trial to use the free models.";
const ENDED = "Your free trial has ended. Sign in to Claude or ChatGPT to keep going.";
const ENDED_WITH_PLAN = "Your free trial has ended. Sign in to Claude or ChatGPT, or keep going on later.dog Cloud in Settings, Computer.";
const ended = () => (planOfferedNow() ? ENDED_WITH_PLAN : ENDED);
const DAILY = "You've used today's free messages. They come back tomorrow, or sign in to Claude or ChatGPT to keep going now.";
const BUSY = "The free model is busy right now. Try again in a minute, or sign in to Claude or ChatGPT.";
const FULL_TODAY = "The free models are at today's limit for everyone. They're back tomorrow, or sign in to Claude or ChatGPT to keep going now.";
const TOO_LARGE = "That was too much for the free model to take in at once, most likely a large screenshot. Try again, or start a new chat.";

export function includedAiError(status: number, body: string): string | undefined {
  let code = "";
  try { code = String((JSON.parse(body) as { error?: { code?: unknown } }).error?.code ?? ""); } catch { code = ""; }
  if (status === 401) return ended();
  if (status === 413) return TOO_LARGE;
  if (status === 429 && code === "daily_limit") return DAILY;
  if (code === "busy_today") return FULL_TODAY;
  if (status === 429 || status === 503 || status === 502) return BUSY;
  return undefined;
}

const notReady = () => (savedTrial()?.ended ? ended() : NOT_STARTED);

function includedDriver(driverKind: string, displayName: string, models: ModelCatalog): ProviderDriver<Record<string, never>> {
  return {
    driverKind,
    metadata: { displayName, supportsMultipleInstances: false },
    models,
    decodeConfig: () => ({}),
    defaultConfig: () => ({}),

    async create(input) {
      return createOpenAIChatRuntime({
        input,
        driverKind,
        apiKey: () => trialAi()?.token ?? "",
        apiUrl: trialAi()?.api ?? FALLBACK_URL,
        models: () => models,
        requestBody: (model, messages, stream) => ({ model: model === INCLUDED_BACKGROUND_MODEL ? model : offeredIncludedModel(models, model), messages, stream }),
        httpErrorLabel: displayName,
        errorText: includedAiError,
        missingKeyError: notReady(),
        unavailableReason: notReady(),
        timeoutMs: 120_000,
        generateModel: () => INCLUDED_BACKGROUND_MODEL,
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
}

export const IncludedAiDriver = includedDriver(INCLUDED_AI_DRIVER, "Claude", INCLUDED_CLAUDE_MODELS);
export const IncludedGrokDriver = includedDriver(INCLUDED_GROK_DRIVER, "Grok", INCLUDED_GROK_MODELS);
