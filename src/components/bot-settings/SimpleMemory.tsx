import { X } from "lucide-react";
import { useEffect, useState } from "react";
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

export function SimpleMemory({ bot, active, onToggle }: { bot: Bot; active: boolean; onToggle: (enabled: boolean) => void }) {
  const [doc, setDoc] = useState<{ text: string; hash: string } | null>(null);
  const [all, setAll] = useState(false);
  const [files, setFiles] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = bot.memoryEnabled !== false;

  const load = async () => {
    const next = await fetchMemoryDoc(bot.id, MEMORY_INDEX);
    setDoc({ text: next.text, hash: next.hash });
  };

  useEffect(() => {
    if (!active || files) return;
    let cancelled = false;
    void fetchMemoryDoc(bot.id, MEMORY_INDEX)
      .then((next) => { if (!cancelled) setDoc({ text: next.text, hash: next.hash }); })
      .catch(() => { if (!cancelled) setDoc({ text: "", hash: "" }); });
    return () => { cancelled = true; };
  }, [bot.id, active, files]);

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

  if (files) {
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
          <span className="text-[12px] font-medium text-ink-secondary">{t("memory.simple.title")}</span>
          <button type="button" onClick={() => setFiles(false)} className="text-[12px] text-ink-secondary hover:text-ink">
            {t("memory.simple.done")}
          </button>
        </div>
        <MemorySection bot={bot} active={active} onToggle={onToggle} />
      </div>
    );
  }

  const items = doc ? rememberedItems(doc.text) : [];
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <div data-simple-memory>
      <span className={groupLabelCls}>{t("memory.simple.title")}</span>
      <div className="rounded-xl bg-card">
        <div className={cn(rowCls, "flex items-center justify-between gap-3")}>
          <span className="min-w-0 flex-1 text-[14px] text-ink">{t("memory.simple.toggle")}</span>
          <Switch checked={enabled} aria-label={t("memory.simple.toggle")} onClick={() => onToggle(!enabled)} />
        </div>
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
      </div>
      <button type="button" data-memory-files onClick={() => setFiles(true)} className="mt-2 px-1 text-[12px] text-ink-tertiary hover:text-ink-secondary">
        {t("memory.simple.files")}
      </button>
    </div>
  );
}
