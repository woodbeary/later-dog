import type { ModelSelection } from "../contracts.ts";

export interface FirstEngineDeps {
  bots(): readonly { id: string; modelSelection: ModelSelection }[];
  pick(): Promise<ModelSelection>;
  assign(botId: string, selection: ModelSelection): void;
}

export function hasNoModel(bot: { modelSelection: ModelSelection }): boolean {
  return !bot.modelSelection.instanceId;
}

export function firstEngine(deps: FirstEngineDeps): () => Promise<void> {
  let running: Promise<void> | null = null;
  const give = async () => {
    if (!deps.bots().some(hasNoModel)) return;
    const selection = await deps.pick();
    if (!selection.instanceId) return;
    for (const bot of deps.bots()) if (hasNoModel(bot)) deps.assign(bot.id, selection);
  };
  return () => {
    running ??= give()
      .catch((error) => console.warn(`[engines] giving dogs without a model an engine failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = null; });
    return running;
  };
}
