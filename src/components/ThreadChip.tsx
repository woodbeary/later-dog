import { ChevronRight, MessagesSquare, TriangleAlert } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { currentDogName, freshenDogName } from "@/lib/dog-refs";

export function ThreadChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  const title = bot?.tasks?.find(task => task.threadId === ref.threadId)?.title ?? ref.title;
  const storedName = /^(?:Opened|Added to) thread #.* on (.+)$/s.exec(tool.name)?.[1];
  const name = currentDogName(state.bots, ref.botId, storedName ?? t("triggers.deletedBot"));
  const opened = tool.ok === true && tool.name.startsWith("Opened thread #");
  const named = freshenDogName(tool.name, bot, storedName, { leading: true });
  const caption = opened ? `#${title}` : named.replace(`thread #${ref.title}`, () => `thread #${title}`);
  const reply = typeof tool.output === "string"
    ? tool.output.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? ""
    : "";
  return (
    <div className="flex justify-start">
      <button
        type="button"
        data-thread-chip={ref.threadId}
        onClick={() => openThread(dispatch, ref, state)}
        title={t("chat.openThreadOn", { title, name })}
        aria-label={t("chat.openThreadOn", { title, name })}
        className={cn("flex h-6 min-w-0 max-w-[min(560px,100%)] items-center gap-1.5 rounded-full bg-control/70 ps-1.5 pe-2 text-[12px] leading-4 text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus", tool.ok === false && "text-danger")}
      >
        {tool.ok === false ? <TriangleAlert size={13} aria-label={t("chat.row.stepFailed")} className="shrink-0" /> : bot ? <BotAvatar bot={bot} state="happy" size={16} animated={false} /> : <MessagesSquare size={13} aria-hidden="true" className="shrink-0" />}
        <span className="min-w-0 truncate font-medium">{caption}</span>
        {opened && <span className="min-w-0 truncate text-ink-tertiary">· {name}</span>}
        {reply && <span data-thread-chip-reply className="min-w-0 truncate text-ink-tertiary">{reply}</span>}
        <ChevronRight size={12} aria-hidden="true" className="shrink-0" />
      </button>
    </div>
  );
}
