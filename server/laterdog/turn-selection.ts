import type { ModelSelection } from "../contracts.ts";
import { threadModelFallback, type ThreadEngine, type ThreadModelContext } from "../thread-model.ts";

export interface TurnSelectionInput {
  own?: ModelSelection;
  dog: ModelSelection;
  projected: ModelSelection;
  engine: (instanceId: string) => ThreadEngine | undefined;
  context?: ThreadModelContext;
}

export function threadGivesWay(input: TurnSelectionInput): boolean {
  return Boolean(input.own && threadModelFallback(input.own, input.dog, input.engine, input.context));
}

export function turnSelectionFor(input: TurnSelectionInput): ModelSelection {
  return threadGivesWay(input) ? input.dog : input.projected;
}
