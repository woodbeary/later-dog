import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, Users, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { newChatRows, nextActive, rowKey, type NewChatRow } from "@/lib/new-chat";
import { BotAvatar } from "./Avatar";

export function NewChatPicker() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [createId] = useState(() => crypto.randomUUID());
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const creating = state.botCreationPending;
  const rows = useMemo(() => newChatRows<Bot>({ dogs: state.bots, query, grouping, picked }), [state.bots, query, grouping, picked]);
  const members = picked.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const close = () => dispatch({ type: "toggleNewBot", open: false });

  useEffect(() => { field.current?.focus(); }, [grouping]);
  useEffect(() => { setActive(0); }, [query, grouping]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const createGroup = () => {
    if (!members.length) return;
    dispatch({ type: "createGroup", memberIds: members.map((member) => member.id) });
    track("room_created", { members: members.length });
    close();
  };

  const choose = (row: NewChatRow<Bot>) => {
    if (row.kind === "create-dog") {
      if (creating) return;
      setError("");
      dispatch({
        type: "newBot",
        createId,
        name: row.name ?? undefined,
        onCreated: () => close(),
        onError: (message) => setError(message),
      });
      return;
    }
    if (row.kind === "create-group") {
      setGrouping(true);
      setQuery("");
      return;
    }
    if (grouping) {
      setPicked((now) => (now.includes(row.dog.id) ? now.filter((id) => id !== row.dog.id) : [...now, row.dog.id]));
      setQuery("");
      return;
    }
    dispatch({ type: "select", id: row.dog.id });
    close();
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((now) => nextActive(now, rows.length, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) choose(row);
      else if (grouping) createGroup();
      return;
    }
    if (event.key === "Backspace" && !query && grouping && picked.length) setPicked((now) => now.slice(0, -1));
  };

  const label = (row: NewChatRow<Bot>) => row.kind === "dog" ? row.dog.name
    : row.kind === "create-group" ? t("newChat.createGroup")
      : row.name ? t("newChat.addAsDog", { name: row.name }) : t("newChat.createDog");

  return (
    <div className="fixed inset-0 z-[70] flex justify-center bg-black/30 px-3 pt-[12vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label={t("newChat.title")} className="flex h-fit max-h-[70vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-menu shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2 border-b border-hairline/40 px-4 py-3">
          <span className="text-[15px] text-ink-secondary">{t("newChat.to")}</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {members.map((member) => (
              <button
                key={member.id}
                type="button"
                onClick={() => setPicked((now) => now.filter((id) => id !== member.id))}
                aria-label={t("newChat.remove", { name: member.name })}
                className="flex max-w-[160px] items-center gap-1 rounded-full bg-raised px-2.5 py-0.5 text-[13px] text-ink hover:bg-control-hover"
              >
                <span className="truncate">{member.name}</span>
                <X size={12} className="shrink-0 text-ink-secondary" />
              </button>
            ))}
            <input
              ref={field}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKey}
              maxLength={100}
              placeholder={members.length ? "" : t("newChat.placeholder")}
              aria-label={t("newChat.placeholder")}
              aria-activedescendant={rows[active] ? `new-chat-${rowKey(rows[active])}` : undefined}
              className="min-w-[120px] flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-tertiary focus:outline-none"
            />
          </div>
          <button type="button" onClick={close} aria-label={t("newChat.close")} title={t("newChat.close")} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div ref={list} role="listbox" aria-label={t("newChat.title")} aria-multiselectable={grouping || undefined} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 && <div className="px-3 py-5 text-center text-[13px] text-ink-secondary">{t("newChat.noMatch")}</div>}
          {rows.map((row, index) => (
            <button
              key={rowKey(row)}
              id={`new-chat-${rowKey(row)}`}
              data-row={index}
              type="button"
              role="option"
              aria-selected={row.kind === "dog" && grouping ? row.picked : index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(row)}
              disabled={row.kind === "create-dog" && creating}
              className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[14px] text-ink", index === active ? "bg-raised" : "hover:bg-raised/60")}
            >
              {row.kind === "dog"
                ? <BotAvatar bot={row.dog} state="happy" size={28} />
                : (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-control text-ink-secondary">
                    {row.kind === "create-group" ? <Users size={15} /> : <Plus size={16} />}
                  </span>
                )}
              <span className="min-w-0 flex-1 truncate">{label(row)}</span>
              {row.kind === "create-dog" && creating && <Loader2 size={15} className="animate-spin text-ink-secondary" />}
              {row.kind === "dog" && grouping && (
                row.picked
                  ? <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent text-white"><Check size={12} /></span>
                  : index === active && <span className="shrink-0 text-[12px] text-ink-secondary">{t("newChat.addToGroup")}</span>
              )}
            </button>
          ))}
        </div>
        {error && <div className="border-t border-hairline/40 px-4 py-2 text-[13px] text-danger">{error}</div>}
        {grouping && (
          <div className="border-t border-hairline/40 p-2">
            <button
              type="button"
              onClick={createGroup}
              disabled={!members.length}
              className="w-full rounded-xl bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {members.length === 0
                ? t("sidebar.newChannel.create")
                : members.length === 1
                  ? t("sidebar.newChannel.createOne")
                  : t("sidebar.newChannel.createMany", { count: members.length })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
