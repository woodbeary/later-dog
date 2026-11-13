import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { statusActivity } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";
import type { RecoveredItem } from "@/lib/quiet-lines";
import type { InstanceInfo } from "@/state/store";
import { FailedTurnRow } from "./FailedTurnRow";

export function RecoveredLine({ item, engine, botId, threadId, forceOpen = false }: {
  item: RecoveredItem;
  engine: InstanceInfo | undefined;
  botId?: string;
  threadId?: string;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(forceOpen);
  const text = statusActivity(item.recovery)?.text ?? "";
  return (
    <div data-recovered className="flex flex-col items-start gap-1.5">
      <div role="status" className="flex w-fit max-w-full flex-wrap items-start gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
        <RefreshCw size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{text}</span>
        <button
          type="button"
          data-recovered-toggle
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="text-[12px] underline decoration-ink-secondary/40 underline-offset-2 hover:text-ink"
        >
          {t("chat.error.details")}
        </button>
      </div>
      {open && item.folded.map((message) => message.tool && (
        <div key={message.id} className="contents" data-mid={message.id}>
          <FailedTurnRow tool={message.tool} engine={engine} botId={botId} threadId={threadId} />
        </div>
      ))}
    </div>
  );
}
