import { ChevronRight, MessagesSquare } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import { freshenDogName } from "@/lib/dog-refs";

export function ThreadChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  const reply = tool.ok && typeof tool.output === "string"
    ? tool.output.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? ""
    : "";
  return (
    <div className="flex justify-start">
      <button
        type="button"
        data-thread-chip={ref.threadId}
        onClick={() => openThread(dispatch, ref, state)}
        title={t("chat.openThread", { title: ref.title })}
        className="flex min-w-0 max-w-[min(560px,100%)] items-center gap-2 rounded-full bg-control/70 py-1 pl-1.5 pr-2.5 text-[13px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
      >
        {bot ? <BotAvatar bot={bot} state="happy" size={18} /> : <MessagesSquare size={13} aria-hidden="true" />}
        <span className="shrink-0 font-medium text-ink">{freshenDogName(tool.name, bot)}</span>
        {reply && <span data-thread-chip-reply className="min-w-0 truncate text-ink-tertiary">{reply}</span>}
        <ChevronRight size={13} className="shrink-0" />
      </button>
    </div>
  );
}
