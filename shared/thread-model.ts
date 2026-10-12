import type { ModelSelection } from "./wire.ts";

export function sameModelSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;
}

export function threadsOnOwnModel<T extends { modelSelection?: ModelSelection; followsBotModel?: boolean }>(
  botModel: ModelSelection,
  tasks: readonly T[],
): T[] {
  return tasks.filter((task) => task.followsBotModel === false && !sameModelSelection(task.modelSelection ?? botModel, botModel));
}
