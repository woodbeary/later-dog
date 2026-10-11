import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "../drivers/openai-chat.ts";
import { trialAi } from "./included-trial.ts";

export const INCLUDED_AI_DRIVER = "laterdogAi";
export const INCLUDED_AI_INSTANCE = "laterdogAi";
const FALLBACK_URL = "https://cloud.later.dog/v1/ai";
const MODELS = { default: "later-dog", options: [{ id: "later-dog", label: "later.dog AI", contextWindow: 2_000_000 }] };
const NOT_STARTED = "Start the free trial to use later.dog AI.";

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
      missingKeyError: NOT_STARTED,
      unavailableReason: NOT_STARTED,
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
