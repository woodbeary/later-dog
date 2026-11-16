import type { ModelSelection } from "../../shared/wire.ts";
import { claudeTier, helperModelFor, type HelperModelChoice } from "./helper-model.ts";

export interface DogCreator {
  selection: ModelSelection;
  driverKind: string | undefined;
  helperModel: HelperModelChoice | undefined;
  offered: ReadonlyArray<{ id: string; custom?: boolean }>;
}

export function createdDogModel(creator: DogCreator): ModelSelection | null {
  if (creator.driverKind !== "claudeAgent") return null;
  const own = claudeTier(creator.selection.model);
  if (!own) return null;
  const helper = helperModelFor("claude", creator.selection.model, creator.helperModel);
  const tier = helper.kind === "model" ? claudeTier(helper.model) : own;
  if (tier === own) return { ...creator.selection };
  const offered = creator.offered.filter(option => !option.custom && claudeTier(option.id) === tier);
  const model = offered.find(option => helper.kind === "model" && option.id === helper.model) ?? offered[0];
  return model ? { instanceId: creator.selection.instanceId, model: model.id } : null;
}
