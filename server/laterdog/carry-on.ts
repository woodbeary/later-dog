import type { ModelSelection } from "../../shared/wire.ts";
import { failedTurnTool, type FailedTurnTool } from "../../shared/failed-turn.ts";
import { CONTINUE_AFTER_RESET, carryOnNotice, limitRowToReplace, type AccountBattery, type BatteryAccount } from "./account-battery.ts";
import type { Notice, PathMessage } from "./continue-on-account.ts";

export interface CarryOnInput {
  battery: AccountBattery;
  accounts: readonly BatteryAccount[];
  threadId: string;
  selection: ModelSelection;
  generation: string | undefined;
  path: readonly PathMessage[];
}

export type CarryOnOutcome = "started" | "full" | "skipped";

function keptRequest(input: CarryOnInput) {
  const { battery, accounts, threadId, selection, path } = input;
  if (!battery.enabled) return undefined;
  const turn = battery.keptTurn(threadId, input.generation);
  const at = path.findLastIndex((message) => message.role === "user" && message.kind === "text");
  if (!turn?.rerun || at === -1 || path[at]!.id !== turn.requestMessageId) return undefined;
  const routed = battery.route(selection, accounts, threadId).instanceId;
  const to = accounts.find((account) => account.instanceId === routed);
  return to?.eligible ? { at, to } : undefined;
}

export function carriesOn(input: CarryOnInput): boolean {
  return keptRequest(input) !== undefined;
}

export function carryOnAfterReset(input: CarryOnInput & {
  full: boolean;
  write: (tool: Notice | FailedTurnTool, replaceId?: string) => void;
}): CarryOnOutcome {
  const { battery, accounts, selection, path } = input;
  const kept = keptRequest(input);
  if (!kept || battery.restOf(kept.to, accounts, selection.model)) return "skipped";
  if (input.full) return "full";
  const turn = battery.takeTurn(input.threadId, input.generation)!;
  battery.takeBack(input.threadId, kept.to.instanceId);
  const name = kept.to.displayName || kept.to.instanceId;
  input.write({ name: `recovery: ${carryOnNotice(name)}`, ok: true }, limitRowToReplace(path, turn.requestMessageId)?.id);
  const toolRan = path.slice(kept.at + 1).some((message) => message.kind === "activity" && Boolean(message.tool?.itemId));
  void turn.rerun!(toolRan ? CONTINUE_AFTER_RESET : null).catch((error: unknown) => {
    input.write(failedTurnTool(`Could not carry on with ${name}: ${error instanceof Error ? error.message : String(error)}`));
  });
  return "started";
}
