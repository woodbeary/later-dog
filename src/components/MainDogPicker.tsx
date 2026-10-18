import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "lucide-react";

import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { BotAvatar } from "./Avatar";

export function mainDogChoices(bots: readonly Bot[], currentId: string, query: string): Bot[] {
  const needle = query.trim().toLowerCase();
  return bots.filter((bot) => bot.id !== currentId && !bot.hidden && (!needle || bot.name.toLowerCase().includes(needle)));
}

export function MainDogPicker({ bots, currentId, onCancel, onConfirm }: {
  bots: readonly Bot[];
  currentId: string;
  onCancel: () => void;
  onConfirm: (botId: string) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  useModalDialog(dialog, onCancel);
  const choices = mainDogChoices(bots, currentId, query);
  const chosen = picked && bots.some((bot) => bot.id === picked && bot.id !== currentId && !bot.hidden) ? picked : null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        className="flex max-h-[min(560px,90dvh)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none">
        <h2 id={`${id}-title`} className="border-b border-hairline/40 px-5 py-4 text-[16px] font-semibold text-ink">{t("mainDog.pickerTitle")}</h2>
        <div className="px-5 pt-4">
          <label className="flex items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3 py-2 focus-within:border-focus">
            <Search size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("mainDog.search")}
              aria-label={t("mainDog.search")} className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none" />
          </label>
        </div>
        <div role="radiogroup" aria-labelledby={`${id}-title`} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {choices.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-ink-secondary">{t("mainDog.noOthers")}</p>}
          {choices.map((bot) => (
            <button key={bot.id} type="button" role="radio" aria-checked={chosen === bot.id} data-main-dog-choice={bot.id}
              onClick={() => setPicked(bot.id)} onDoubleClick={() => onConfirm(bot.id)}
              className={cn("flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[14px] text-ink",
                chosen === bot.id ? "bg-raised" : "hover:bg-raised/60")}>
              <BotAvatar bot={bot} state="happy" size={28} animated={false} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              {chosen === bot.id && <Check size={15} className="shrink-0 text-ink" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-3">
          <button type="button" onClick={onCancel} className="rounded-full bg-control px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover">{t("common.cancel")}</button>
          <button type="button" disabled={!chosen} onClick={() => chosen && onConfirm(chosen)}
            className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel disabled:opacity-40">{t("mainDog.confirm")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
