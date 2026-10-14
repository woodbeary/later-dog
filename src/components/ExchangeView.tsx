import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { closeExchange } from "@/lib/exchange-view";
import { BotAvatar } from "./Avatar";
import { Transcript } from "./GroupView";

const NOOP = () => {};

export default function ExchangeView({ groupId }: { groupId: string }) {
  const { state } = useStore();
  const group = state.groups.find((candidate) => candidate.id === groupId);
  const members = useMemo(
    () => (group?.memberIds ?? []).flatMap((id) => state.bots.find((bot) => bot.id === id) ?? []),
    [group?.memberIds, state.bots],
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExchange();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const lastId = group?.messages.at(-1)?.id;
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastId]);
  if (!group) return null;
  return (
    <section
      role="dialog"
      aria-label={group.name}
      data-exchange-view
      className="absolute inset-0 z-[40] flex min-h-0 flex-col bg-app"
    >
      <header className="flex items-center justify-center px-5 py-3">
        <div className="flex items-center gap-2 rounded-full bg-control px-3 py-1.5 text-[14px] font-medium text-ink">
          {members.map((member, index) => (
            <span key={member.id} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden="true" className="text-ink-tertiary">⇄</span>}
              <BotAvatar bot={member} state="happy" size={20} motion="none" motionKey={0} animated={false} />
              <span data-exchange-member>{member.name}</span>
            </span>
          ))}
        </div>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <div className="flex w-full flex-col gap-3" role="log" aria-label={group.name}>
          {group.messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-ink-secondary">{t("chat.exchange.empty")}</p>
          ) : (
            <Transcript
              group={group}
              members={members}
              locale={activeLocale()}
              messages={group.messages}
              transcript={group.messages}
              onReply={NOOP}
              readOnly
            />
          )}
        </div>
      </div>
      <footer className="flex flex-col items-center gap-2 px-5 pb-5 pt-2">
        <p className="text-center text-[12.5px] text-ink-tertiary">{t("chat.exchange.readOnly")}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={closeExchange}
          className="rounded-full bg-control px-5 py-2 text-[14px] font-medium text-ink transition-colors hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t("chat.exchange.close")}
        </button>
      </footer>
    </section>
  );
}
