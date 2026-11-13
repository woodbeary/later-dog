import type { TurnReceipt } from "../../shared/turn-receipt.ts";
import type { ExecutionEvidence } from "./execution-evidence.ts";

export function turnReceipt(evidence: ExecutionEvidence, accountName: (instanceId: string) => string | undefined): TurnReceipt | undefined {
  const { selected, dispatched } = evidence;
  const instanceId = evidence.providerInstanceId;
  const account = accountName(instanceId)?.trim();
  const reported = evidence.reportedModel?.trim();
  if (evidence.attribution === "conflict") {
    return reported ? { instanceId, model: reported, ...(account ? { account } : {}) } : undefined;
  }
  const differs = selected.instanceId !== instanceId || selected.model !== dispatched.model || selected.effort !== dispatched.effort;
  return {
    instanceId,
    model: dispatched.model,
    ...(account ? { account } : {}),
    ...(reported && reported !== dispatched.model ? { reportedModel: reported } : {}),
    ...(dispatched.effort ? { effort: dispatched.effort } : {}),
    ...(differs ? { selected: { instanceId: selected.instanceId, model: selected.model, ...(selected.effort ? { effort: selected.effort } : {}) } } : {}),
  };
}
