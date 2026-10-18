import type { EffortLevel, EngineAccess, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { fitEffort, modelEffortLevels } from "../shared/effort.ts";
import { isIncludedEngine } from "../shared/account-engines.ts";

export interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
  access?: EngineAccess;
}

export interface DefaultSelectionContext {
  company?: (instanceId: string) => boolean;
  refusal?: (instance: SelectableInstance) => string | undefined;
}

const claudeFirst = (instances: readonly SelectableInstance[]) =>
  instances.find((instance) => instance.driverKind === "claudeAgent")
    ?? instances.find((instance) => !isIncludedEngine(instance.driverKind))
    ?? instances[0];

export function signedOut(instance: SelectableInstance): boolean {
  return instance.snapshot.state === "available" && instance.access !== "custom" && instance.snapshot.authenticated === false;
}

export function readyToRun(instance: SelectableInstance, context: DefaultSelectionContext = {}): boolean {
  return instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && !signedOut(instance);
}

export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
  context: DefaultSelectionContext = {},
): ModelSelection {
  if (preferred) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    if (
      instance?.snapshot.state !== "available" ||
      instance.snapshot.authenticated === false ||
      context.refusal?.(instance) !== undefined ||
      (preferred.variant !== undefined && !instance.capabilities?.modelVariants) ||
      !(instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))
    ) {
      return { instanceId: "", model: "" };
    }
    const selection = { ...preferred };
    const offered = instance.capabilities?.effortLevels ?? [];
    const fitted = selection.effort && offered.includes(selection.effort)
      ? fitEffort(modelEffortLevels(offered, instance.models.options.find((model) => model.id === selection.model)), selection.effort)
      : undefined;
    if (fitted) selection.effort = fitted;
    else delete selection.effort;
    return selection;
  }
  const available = instances.filter((instance) => instance.snapshot.state === "available" && context.refusal?.(instance) === undefined);
  const ready = available.filter((instance) => readyToRun(instance, context));
  const company = context.company;
  const personal = company && instances.some((instance) => company(instance.instanceId))
    ? claudeFirst(ready.filter((instance) => !company(instance.instanceId)))
    : undefined;
  const pick = personal ?? claudeFirst(ready) ?? claudeFirst(available);
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}

export function withNewBotEffort(
  selection: ModelSelection,
  effort: EffortLevel | undefined,
  offered: readonly EffortLevel[] | undefined,
): ModelSelection {
  if (!effort || selection.effort !== undefined || selection.variant !== undefined || !offered?.includes(effort)) {
    return selection;
  }
  return { ...selection, effort };
}
