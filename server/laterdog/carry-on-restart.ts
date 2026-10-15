import type { ModelSelection } from "../../shared/wire.ts";
import { failedTurnTool, type FailedTurnTool } from "../../shared/failed-turn.ts";
import { CONTINUE_AFTER_RESET, carryOnNotice, selectionOnAccount, type AccountBattery, type BatteryAccount } from "./account-battery.ts";
import { latestLimit, type Notice, type PathMessage } from "./continue-on-account.ts";

export type RestartOutcome = "started" | "full" | "waiting" | "skipped";

export interface RestartInput {
  battery: AccountBattery;
  accounts: readonly BatteryAccount[];
  threadId: string;
  selection: ModelSelection;
  path: readonly PathMessage[];
  full: boolean;
  write: (tool: Notice | FailedTurnTool, replaceId?: string) => void;
  start: (text: string, requestMessageId: string) => Promise<unknown>;
}

export function carryOnAfterRestart(input: RestartInput): RestartOutcome {
  const { battery, accounts, threadId, selection, path } = input;
  if (!battery.enabled) return "skipped";
  const request = path.findLast((message) => message.role === "user" && message.kind === "text");
  const limit = latestLimit(path);
  if (!request || !limit) return "skipped";
  const to = accounts.find((account) => account.instanceId === battery.route(selection, accounts, threadId).instanceId);
  if (!to?.eligible) return "skipped";
  if (battery.restOf(to, accounts, selectionOnAccount(selection, to, accounts, battery.preferredFor(threadId)).model)) return "waiting";
  if (input.full) return "full";
  battery.arrive(threadId, selection, to.instanceId, accounts);
  const name = to.displayName || to.instanceId;
  input.write({ name: `recovery: ${carryOnNotice(name)}`, ok: true, carry: { from: limit.tool?.quota?.instanceId ?? selection.instanceId, to: to.instanceId } }, limit.id);
  void input.start(CONTINUE_AFTER_RESET, request.id).catch((error: unknown) => {
    input.write(failedTurnTool(`Could not carry on with ${name}: ${error instanceof Error ? error.message : String(error)}`));
  });
  return "started";
}
