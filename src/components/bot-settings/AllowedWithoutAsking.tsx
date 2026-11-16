import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";
import type { AlwaysAllowedItem, AlwaysAllowedList } from "../../../shared/lasting-allows";

const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";
const quietButtonCls = "shrink-0 rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

function itemLabel(item: AlwaysAllowedItem): string {
  switch (item.kind) {
    case "search": return t("allowed.search");
    case "app": return t("allowed.connector", { app: item.subject ?? "" });
    case "outside-delete": return t("allowed.outsideDelete");
    case "saved-login": return t("allowed.vault", { site: item.subject ?? "" });
    case "teammate": return t("allowed.teammate", { name: item.subject ?? t("allowed.otherDog") });
    case "command": return t("allowed.command", { command: item.subject ?? "" });
  }
}

export function AllowedWithoutAsking({ bot }: { bot: Bot }) {
  const [list, setList] = useState<AlwaysAllowedList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<AlwaysAllowedList>(`/api/bots/${bot.id}/always-allowed`)
      .then((answer) => { if (!cancelled) setList(answer); })
      .catch(() => { if (!cancelled) setList(null); });
    return () => { cancelled = true; };
  }, [bot.id, bot.alwaysAllow]);

  if (!list) return null;

  const change = async (id: string, path: string, method: "DELETE" | "POST") => {
    setBusy(id);
    setFailed(false);
    try {
      setList(await api<AlwaysAllowedList>(path, { method }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-always-allowed>
      <span className={groupLabelCls}>{t("allowed.title")}</span>
      {list.paused && (
        <div data-always-allowed-paused className="mb-2 flex items-center gap-3 rounded-xl bg-card px-4 py-3">
          <span className="min-w-0 flex-1 text-[13.5px] text-ink">{t("allowed.paused")}</span>
          <button type="button" disabled={busy !== null} className={quietButtonCls}
            onClick={() => void change("resume", `/api/bots/${bot.id}/always-allowed/resume`, "POST")}>
            {t("allowed.resume")}
          </button>
        </div>
      )}
      {list.items.length ? (
        <div className="rounded-xl bg-card">
          {list.items.map((item, index) => (
            <div key={item.id} data-allowed={item.id} data-allowed-state={item.state} className={cn(index === 0 ? rowCls : dividedRowCls, "flex items-center gap-3")}>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-[13.5px]", item.state === "active" ? "text-ink" : "text-ink-tertiary", item.kind === "command" ? "truncate font-mono text-[12.5px]" : "break-words")}>{itemLabel(item)}</span>
                {item.state === "no-longer-used" && <span className="block text-[12px] text-ink-tertiary">{t("allowed.noLongerUsed")}</span>}
              </span>
              <button type="button" disabled={busy !== null} className={quietButtonCls}
                onClick={() => void change(item.id, `/api/bots/${bot.id}/always-allowed/${encodeURIComponent(item.id)}`, "DELETE")}>
                {t("allowed.remove")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p data-always-allowed-empty className="rounded-xl bg-card px-4 py-3 text-[13.5px] text-ink-secondary">{t("allowed.empty")}</p>
      )}
      <p className="mt-1.5 px-1 text-[12px] text-ink-tertiary">{failed ? t("allowed.removeFailed") : t("allowed.hint", { name: bot.name })}</p>
    </div>
  );
}
