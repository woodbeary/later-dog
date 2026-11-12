import type { TurnReceipt } from "../../shared/turn-receipt";
import type { InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { effortName } from "@/lib/model-friendly";

type Instances = readonly Pick<InstanceInfo, "instanceId" | "displayName" | "driverKind" | "models">[];

function modelName(instances: Instances, instanceId: string, model: string): string {
  return instances.find((instance) => instance.instanceId === instanceId)?.models.options.find((option) => option.id === model)?.label || model;
}

export function receiptLine(receipt: TurnReceipt | undefined, instances: Instances): string | null {
  if (!receipt?.model) return null;
  const driverKind = instances.find((instance) => instance.instanceId === receipt.instanceId)?.driverKind;
  const ran = [
    receipt.reportedModel ?? modelName(instances, receipt.instanceId, receipt.model),
    ...(receipt.effort ? [effortName(receipt.effort, driverKind)] : []),
  ].join(" · ");
  const line = receipt.account ? t("chat.receipt.ranOn", { account: receipt.account, ran }) : t("chat.receipt.ran", { ran });
  const chosen = receipt.selected;
  if (!chosen) return line;
  const chosenDriver = instances.find((instance) => instance.instanceId === chosen.instanceId)?.driverKind;
  const picked = [
    ...(chosen.instanceId !== receipt.instanceId ? [instances.find((instance) => instance.instanceId === chosen.instanceId)?.displayName].filter((name): name is string => Boolean(name)) : []),
    ...(chosen.model !== receipt.model ? [modelName(instances, chosen.instanceId, chosen.model)] : []),
    ...(chosen.effort && chosen.effort !== receipt.effort ? [effortName(chosen.effort, chosenDriver)] : []),
  ];
  return picked.length ? `${line} · ${t("chat.receipt.selected", { selected: picked.join(" · ") })}` : line;
}
