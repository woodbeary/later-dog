import type { ModelSelection } from "../contracts.ts";
import { signedOut } from "../default-model-selection.ts";
import { threadModelFallback, type ThreadEngine, type ThreadModelContext } from "../thread-model.ts";

export interface TurnSelectionInput {
  own?: ModelSelection;
  dog: ModelSelection;
  projected: ModelSelection;
  engine: (instanceId: string) => ThreadEngine | undefined;
  context?: ThreadModelContext;
}

function waitsForPerson(own: ModelSelection, engine: ThreadEngine | undefined, context: ThreadModelContext): engine is ThreadEngine {
  if (!engine || engine.snapshot.state !== "available" || context.refusal?.(engine) !== undefined || context.allows?.(own) === false) return false;
  return !engine.enabled || signedOut(engine);
}

export function threadGivesWay(input: TurnSelectionInput): boolean {
  if (!input.own) return false;
  const context = input.context ?? {};
  const fallback = threadModelFallback(input.own, input.dog, input.engine, context);
  if (!fallback) return false;
  if (fallback === "pinned-engine") return true;
  const mine = input.engine(input.own.instanceId);
  if (!waitsForPerson(input.own, mine, context)) return true;
  return mine.driverKind === input.engine(input.dog.instanceId)?.driverKind;
}

export function turnSelectionFor(input: TurnSelectionInput): ModelSelection {
  return threadGivesWay(input) ? input.dog : input.projected;
}
