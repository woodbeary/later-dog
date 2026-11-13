import type { ModelSelection } from "./contracts.ts";
import { readyToRun, signedOut, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import { sameModelSelection } from "../shared/thread-model.ts";
import { readingRuns } from "./laterdog/cli-version.ts";

export type ThreadEngine = SelectableInstance & { enabled: boolean };

export type ThreadModelFallback = "unavailable" | "signed-out" | "pinned-engine";

export interface ThreadModelContext extends DefaultSelectionContext {
  pinned?: boolean;
  ownerSelection?: ModelSelection;
  allows?: (selection: ModelSelection) => boolean;
}

function canRunOn(engine: ThreadEngine | undefined, selection: ModelSelection, context: ThreadModelContext): engine is ThreadEngine {
  return Boolean(engine?.enabled) && readingRuns(engine!.snapshot) && context.refusal?.(engine!) === undefined &&
    context.allows?.(selection) !== false;
}

export function threadModelFallback(
  own: ModelSelection,
  botModel: ModelSelection,
  engine: (instanceId: string) => ThreadEngine | undefined,
  context: ThreadModelContext = {},
): ThreadModelFallback | null {
  if (sameModelSelection(own, botModel)) return null;
  const mine = engine(own.instanceId);
  const pinnedEngine = engine(botModel.instanceId);
  if (context.pinned && mine && pinnedEngine && mine.driverKind !== pinnedEngine.driverKind &&
      (!context.ownerSelection || !sameModelSelection(own, context.ownerSelection))) return "pinned-engine";
  if (!canRunOn(mine, own, context)) return "unavailable";
  if (!signedOut(mine)) return null;
  const theirs = engine(botModel.instanceId);
  return canRunOn(theirs, botModel, context) && readyToRun(theirs, context) ? "signed-out" : null;
}
