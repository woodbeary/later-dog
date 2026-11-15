import type { ModelCatalog, TextGenerationOptions } from "../contracts.ts";

export const APPROVAL_REVIEW_MODEL = "claude-haiku-4-5";

export function writingModel(chatModel: string | null | undefined, catalog: ModelCatalog): string | undefined {
  return chatModel?.trim() || catalog.default?.trim() || catalog.options[0]?.id || undefined;
}

export interface DogWriter {
  (prompt: string, options?: Omit<TextGenerationOptions, "model">): Promise<string>;
  readonly model: string;
}

export interface TextEngine {
  readonly models: ModelCatalog;
  generateText?(prompt: string, options?: TextGenerationOptions): Promise<string>;
}

export function dogWriter(instance: TextEngine, chatModel: string | null | undefined): DogWriter | undefined {
  const model = writingModel(chatModel, instance.models);
  if (!instance.generateText || !model) return undefined;
  const generate = instance.generateText.bind(instance);
  return Object.assign((prompt: string, options?: Omit<TextGenerationOptions, "model">) => generate(prompt, { ...options, model }), { model });
}
