import type { WireMessage } from "../../shared/wire.ts";
import { personLine } from "./history-summary.ts";

export const EARLIER_LINE = "Earlier messages in this chat were summarized.";

export function rowForApps<M extends Pick<WireMessage, "compaction">>(message: M): M {
  const compaction = message.compaction;
  if (!compaction?.summary.trim().includes("\n")) return message;
  return { ...message, compaction: { ...compaction, summary: compaction.by === "person" ? personLine("person") : EARLIER_LINE } };
}
