import type { ModelSelection } from "../../shared/wire.ts";
import { sameModelSelection } from "../../shared/thread-model.ts";

export const CONTINUE_AFTER_PICK =
  "[later.dog: the person moved this conversation to another account partway through your last turn, " +
  "so it continues there. Anything that turn already did (files written, commands run) is still in place, " +
  "but its tool results are not in this session. Check the current state, then continue the person's last request from " +
  "where it stopped. Do not redo what was already done.]";

export function pickMovesTurn(input: {
  before: ModelSelection | undefined;
  after: ModelSelection;
  runningOn: string | undefined;
  routedTo: string;
}): boolean {
  const { before, after, runningOn, routedTo } = input;
  if (!runningOn || runningOn === routedTo || routedTo !== after.instanceId) return false;
  return before?.instanceId !== after.instanceId || sameModelSelection(before, after);
}

export function pickNotice(to: string, from: string): string {
  return `Moved to ${to} from ${from}, as you picked.`;
}
