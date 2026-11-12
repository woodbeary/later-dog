import type { TurnReceipt } from "../../shared/turn-receipt";
import { useStoreSelector } from "@/state/store-selectors";
import { receiptLine } from "@/lib/turn-receipt";

export function TurnReceiptLine({ receipt }: { receipt: TurnReceipt | undefined }) {
  const instances = useStoreSelector((state) => state.instances);
  const line = receiptLine(receipt, instances);
  if (!line) return null;
  return <div data-turn-receipt="" className="mt-1 pl-1 text-[11px] text-ink-tertiary">{line}</div>;
}
