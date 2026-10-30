import { useEffect, useState } from "react";

import { allowedItems, withoutGrant, type AllowedItem } from "@/lib/allowed";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot, type BotAnnouncement } from "@/state/store";
import type { CommandAllowlistResponse, CommandAllowlistRule } from "../../../shared/command-allowlist";

const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";

function itemWords(item: AllowedItem, dogName: (id: string) => string): { label: string; detail?: string } {
  switch (item.kind) {
    case "connector": return { label: t("allowed.connector", { app: item.app }) };
    case "askDog": return { label: t("allowed.askDog", { name: dogName(item.dogId) }) };
    case "delegateDog": return { label: t("allowed.delegateDog", { name: dogName(item.dogId) }) };
    case "command": return { label: t("allowed.command", { command: item.command }), detail: t("allowed.commandIn", { cwd: item.cwd }) };
    default: return { label: item.key };
  }
}

export function AllowedWithoutAsking({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [rules, setRules] = useState<CommandAllowlistRule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<CommandAllowlistResponse>(`/api/bots/${bot.id}/command-allowlist`)
      .then((answer) => { if (!cancelled) setRules(answer.rules); })
      .catch(() => { if (!cancelled) setRules([]); });
    return () => { cancelled = true; };
  }, [bot.id]);

  const items = allowedItems(bot.alwaysAllow, rules);
  if (!items.length) return null;
  const dogName = (id: string) => state.bots.find((candidate) => candidate.id === id)?.name ?? t("allowed.otherDog");

  const remove = async (item: AllowedItem) => {
    const id = item.kind === "command" ? item.id : item.key;
    setBusy(id);
    setFailed(false);
    try {
      if (item.kind === "command") {
        const answer = await api<CommandAllowlistResponse>(`/api/bots/${bot.id}/command-allowlist/${item.id}`, { method: "DELETE" });
        setRules(answer.rules);
      } else {
        const answer = await api<{ bot: BotAnnouncement }>(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ alwaysAllow: withoutGrant(bot.alwaysAllow, item.key) }) });
        dispatch({ type: "botPatched", bot: answer.bot });
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-allowed-without-asking>
      <span className={groupLabelCls}>{t("allowed.title")}</span>
      <div className="rounded-xl bg-card">
        {items.map((item, index) => {
          const id = item.kind === "command" ? item.id : item.key;
          const words = itemWords(item, dogName);
          return (
            <div key={id} data-allowed={id} className={cn(index === 0 ? rowCls : dividedRowCls, "flex items-center gap-3")}>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-[13.5px] text-ink", item.kind === "command" ? "truncate font-mono text-[12.5px]" : "break-words")}>{words.label}</span>
                {words.detail && <span className="block truncate text-[12px] text-ink-secondary">{words.detail}</span>}
              </span>
              <button type="button" disabled={busy !== null} onClick={() => void remove(item)}
                className="shrink-0 rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
                {t("allowed.remove")}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 px-1 text-[12px] text-ink-tertiary">{failed ? t("allowed.removeFailed") : t("allowed.hint", { name: bot.name })}</p>
    </div>
  );
}
