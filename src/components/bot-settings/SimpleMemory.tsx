import { ChevronRight, NotebookPen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MEMORY_INDEX, fetchMemoryDoc, saveMemoryDoc } from "@/lib/memory";
import type { Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { MemorySection } from "./MemorySection";

const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";
const SHOWN = 8;

export function rememberedItems(text: string): Array<{ line: string; words: string }> {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (!match) return [];
    const words = match[1]
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
    return words ? [{ line, words }] : [];
  });
}

export function withoutLine(text: string, line: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((candidate) => candidate.replace(/\r$/, "") === line.replace(/\r$/, ""));
  if (index < 0) return text;
  lines.splice(index, 1);
  return lines.join("\n");
}

export function SimpleMemory({ bot, active, page, onPage, onToggle }: {
  bot: Bot;
  active: boolean;
  page: boolean;
  onPage: (open: boolean) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const [doc, setDoc] = useState<{ text: string; hash: string } | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visited, setVisited] = useState(page);
  const manageRow = useRef<HTMLButtonElement | null>(null);
  const returning = useRef(false);
  const enabled = bot.memoryEnabled !== false;
  if (page && !visited) setVisited(true);

  const load = async () => {
    const next = await fetchMemoryDoc(bot.id, MEMORY_INDEX);
    setDoc({ text: next.text, hash: next.hash });
  };

  useEffect(() => {
    if (page || !returning.current) return;
    returning.current = false;
    manageRow.current?.focus({ preventScroll: true });
    manageRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [page]);

  useEffect(() => {
    if (!active || page) return;
    let cancelled = false;
    void fetchMemoryDoc(bot.id, MEMORY_INDEX)
      .then((next) => { if (!cancelled) setDoc({ text: next.text, hash: next.hash }); })
      .catch(() => { if (!cancelled) setDoc({ text: "", hash: "" }); });
    return () => { cancelled = true; };
  }, [bot.id, active, page]);

  const forget = async (line: string) => {
    if (!doc || busy) return;
    setBusy(line);
    setError(null);
    try {
      const saved = await saveMemoryDoc(bot.id, MEMORY_INDEX, withoutLine(doc.text, line), doc.hash || undefined);
      if (saved.ok) setDoc({ text: saved.doc.text, hash: saved.doc.hash });
      else {
        setError(t("memory.simple.changed", { name: bot.name }));
        await load().catch(() => {});
      }
    } catch {
      setError(t("memory.simple.forgetFailed"));
    } finally {
      setBusy(null);
    }
  };

  const items = doc ? rememberedItems(doc.text) : [];
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      {(visited || page) && (
        <div hidden={!page}>
          <MemorySection
            bot={bot}
            active={active && page}
            onClose={() => {
              returning.current = true;
              onPage(false);
            }}
          />
        </div>
      )}
      {!page && (
        <div data-simple-memory>
          <span className={groupLabelCls}>{t("memory.simple.title")}</span>
          <div className="overflow-hidden rounded-xl bg-card">
            <div className={cn(rowCls, "flex items-center justify-between gap-3")}>
              <span className="min-w-0 flex-1 text-[14px] text-ink">{t("memory.simple.toggle")}</span>
              <span title={bot.busy ? t("memory.simple.busy", { name: bot.name }) : undefined}>
                <Switch checked={enabled} disabled={bot.busy} aria-label={t("memory.simple.toggle")} onClick={() => onToggle(!enabled)} />
              </span>
            </div>
            {!enabled && (
              <div data-memory-off className={cn(dividedRowCls, "text-[12.5px] leading-relaxed text-ink-tertiary")}>
                {t("memory.simple.offHint", { name: bot.name })}
              </div>
            )}
            {enabled && doc && items.length === 0 && (
              <div className={cn(dividedRowCls, "text-[12.5px] text-ink-tertiary")}>{t("memory.simple.empty", { name: bot.name })}</div>
            )}
            {enabled && shown.map((item) => (
              <div key={item.line} data-remembered className={cn(dividedRowCls, "group flex items-start gap-3")}>
                <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">{item.words}</span>
                <button
                  type="button"
                  onClick={() => void forget(item.line)}
                  disabled={busy !== null}
                  aria-label={t("memory.simple.forget", { words: item.words })}
                  title={t("memory.simple.forgetTitle")}
                  className="shrink-0 rounded-md p-0.5 text-ink-tertiary opacity-0 hover:bg-control hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100 disabled:opacity-40"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {enabled && items.length > SHOWN && (
              <button type="button" onClick={() => setAll((open) => !open)} className={cn(dividedRowCls, "w-full text-left text-[12.5px] text-ink-secondary hover:text-ink")}>
                {all ? t("memory.simple.fewer") : t("memory.simple.all", { count: items.length })}
              </button>
            )}
            {error && <div role="alert" className={cn(dividedRowCls, "text-[12px] text-danger")}>{error}</div>}
            <button
              ref={manageRow}
              type="button"
              data-memory-files
              onClick={() => onPage(true)}
              className={cn(
                dividedRowCls,
                "flex w-full items-center gap-3 text-left transition-colors hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none",
              )}
            >
              <NotebookPen size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t("memory.simple.manage")}</span>
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
