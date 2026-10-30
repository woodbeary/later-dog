import { BookOpen, Brain, CalendarDays, ChevronLeft, ChevronRight, ExternalLink, FileText, FolderOpen, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import {
  MEMORY_INDEX,
  capacityStatus,
  deleteMemoryDoc,
  fetchMemoryDoc,
  fetchMemoryJournal,
  fetchMemoryOverview,
  fetchUpkeepStatus,
  fileManagerLabel,
  journalSource,
  journalSummary,
  noticedCount,
  openMemoryLocation,
  relativeTime,
  revertMemoryChange,
  saveMemoryDoc,
  tidyMemoryNow,
  tidySummary,
  topicFileName,
  type MemoryCapacity,
  type MemoryFileInfo,
  type MemoryJournalRow,
  type MemoryOpenTarget,
  type MemoryOverview,
  type UpkeepStatus,
} from "@/lib/memory";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { useDesktopCapabilities } from "../DesktopCapabilities";

const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const cardCls = "overflow-hidden rounded-xl bg-card divide-y divide-hairline/40";
const rowCls = "px-4 py-3";
const navRowCls = "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none";
const pillCls = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45";
const quietCls = "rounded-full px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-45";
const iconButtonCls = "shrink-0 rounded-full p-1.5 text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const moreCls = "w-full px-4 py-2.5 text-left text-[12.5px] text-ink-secondary hover:text-ink";
const NOTES_SHOWN = 6;
const CHANGES_SHOWN = 5;

interface Editing {
  path: string;
  text: string;
  hash: string;
  dirty: boolean;
  readOnly: boolean;
  exists: boolean;
}

interface Conflict {
  current: string;
  currentHash: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function logDay(stem: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stem);
  if (!match) return stem;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function noteLabel(path: string): string {
  if (path === MEMORY_INDEX) return t("memory.page.main");
  if (path.startsWith("memory/log/")) return logDay(path.slice("memory/log/".length).replace(/\.md$/, ""));
  return path.replace(/^memory\//, "").replace(/\.md$/, "");
}

export function topicTemplate(fileName: string): string {
  const title = fileName.replace(/\.md$/, "");
  return `---\ntitle: ${title}\ndescription: \naliases: []\n---\n\n`;
}

export function MemoryGauge({ index }: { index: MemoryCapacity }) {
  const status = capacityStatus(index);
  const percent = Math.min(100, Math.round(Math.max(status.lineShare, status.byteShare) * 100));
  const over = status.level === "over";
  return (
    <div data-memory-gauge={status.level} className={cn("rounded-xl px-4 py-3", over ? "bg-danger/10" : "bg-card")}>
      <div
        role="meter"
        aria-label={t("memory.gauge.label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-inset"
      >
        <div
          className={cn("h-full rounded-full", over ? "bg-danger" : status.level === "near" ? "bg-warning" : "bg-accent")}
          style={{ width: `${percent}%` }}
        />
      </div>
      {over && status.warning && <p className="mt-2 text-[12.5px] leading-relaxed text-danger">{status.warning}</p>}
      {status.level === "near" && <p className="mt-2 text-[12.5px] leading-relaxed text-ink">{t("memory.gauge.near")}</p>}
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-tertiary">{status.sentence}</p>
    </div>
  );
}

export function ConflictNotice({ botName, busy, onReload, onOverwrite }: {
  botName: string;
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div data-memory-conflict role="alert" className="rounded-xl bg-warning/10 px-4 py-3 text-[12.5px] leading-relaxed text-ink">
      <p className="font-medium">{t("memory.conflict.title", { name: botName })}</p>
      <p className="mt-0.5 text-ink-secondary">{t("memory.conflict.body", { name: botName })}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={pillCls} disabled={busy} onClick={onReload}>{t("memory.conflict.reload")}</button>
        <button type="button" className={quietCls} disabled={busy} onClick={onOverwrite}>{t("memory.conflict.overwrite")}</button>
      </div>
    </div>
  );
}

export function MemoryNotes({ index, topics, now, onOpen, onCreate }: {
  index: MemoryCapacity;
  topics: readonly MemoryFileInfo[];
  now?: number;
  onOpen: (path: string) => void;
  onCreate: (name: string) => boolean;
}) {
  const [all, setAll] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const newRow = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  const level = capacityStatus(index).level;
  const shown = all ? topics : topics.slice(0, NOTES_SHOWN);

  useEffect(() => {
    if (naming || !refocus.current) return;
    refocus.current = false;
    newRow.current?.focus();
  }, [naming]);

  const stopNaming = () => {
    setNaming(false);
    setName("");
  };

  return (
    <section>
      <h4 className={groupLabelCls}>{t("memory.page.notes")}</h4>
      <div className={cardCls}>
        <button type="button" data-memory-note={MEMORY_INDEX} onClick={() => onOpen(MEMORY_INDEX)} className={navRowCls}>
          <Brain size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t("memory.page.main")}</span>
          <span
            data-memory-level={level}
            className={cn("shrink-0 text-[12px]", level === "over" ? "font-medium text-danger" : level === "near" ? "font-medium text-warning" : "text-ink-tertiary")}
          >
            {level === "over" ? t("memory.page.full") : level === "near" ? t("memory.page.nearFull") : t("memory.page.mainHint")}
          </span>
          <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
        </button>
        {shown.map((file) => (
          <button key={file.path} type="button" data-memory-note={file.path} onClick={() => onOpen(file.path)} className={navRowCls}>
            <FileText size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{noteLabel(file.path)}</span>
            <span className="shrink-0 text-[12px] text-ink-tertiary">{relativeTime(file.modifiedAt, now)}</span>
            <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
          </button>
        ))}
        {topics.length > NOTES_SHOWN && (
          <button type="button" onClick={() => setAll((open) => !open)} className={moreCls}>
            {all ? t("memory.simple.fewer") : t("memory.simple.all", { count: topics.length })}
          </button>
        )}
        {naming ? (
          <form
            data-memory-new-form
            className={cn(rowCls, "flex items-center gap-2")}
            onSubmit={(event) => {
              event.preventDefault();
              if (onCreate(name)) stopNaming();
            }}
          >
            <input
              autoFocus
              aria-label={t("memory.page.newNoteName")}
              placeholder={t("memory.page.newNotePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                refocus.current = true;
                stopNaming();
              }}
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
            />
            <button type="submit" disabled={!name.trim()} className={cn(pillCls, "shrink-0")}>{t("memory.page.create")}</button>
          </form>
        ) : (
          <button ref={newRow} type="button" data-memory-new onClick={() => setNaming(true)} className={cn(navRowCls, "text-ink-secondary hover:text-ink")}>
            <Plus size={16} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 text-[14px]">{t("memory.page.newNote")}</span>
          </button>
        )}
      </div>
    </section>
  );
}

export function MemoryLogs({ logs, botName, onOpen }: { logs: readonly MemoryFileInfo[]; botName: string; onOpen: (path: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("memory.page.logsHint", { name: botName })}</p>
      <div className={cardCls}>
        {logs.length === 0 ? (
          <div className={cn(rowCls, "text-[12.5px] text-ink-tertiary")}>{t("memory.page.none")}</div>
        ) : (
          logs.map((file) => (
            <button key={file.path} type="button" data-memory-log={file.path} onClick={() => onOpen(file.path)} className={navRowCls}>
              <CalendarDays size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{noteLabel(file.path)}</span>
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function MemoryJournalList({ rows, botName, reverting, onRevert, now = Date.now() }: {
  rows: readonly MemoryJournalRow[] | null;
  botName: string;
  reverting: string | null;
  onRevert: (row: MemoryJournalRow) => void;
  now?: number;
}) {
  if (!rows) return <div className={cn(rowCls, "text-[12.5px] text-ink-tertiary")}>{t("memory.page.loading")}</div>;
  if (rows.length === 0) return <div className={cn(rowCls, "text-[12.5px] text-ink-tertiary")}>{t("memory.page.noChanges")}</div>;
  return (
    <>
      {rows.map((row) => (
        <div key={row.id} data-memory-change={row.id} className={rowCls}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-ink">{journalSummary(row, botName)}</p>
              <p className="mt-0.5 text-[12px] text-ink-tertiary">{[relativeTime(row.at, now), journalSource(row)].filter(Boolean).join(" · ")}</p>
            </div>
            {row.canRevert ? (
              <button
                type="button"
                disabled={reverting !== null}
                onClick={() => onRevert(row)}
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10 disabled:opacity-50"
              >
                <RotateCcw size={12} aria-hidden="true" />
                {reverting === row.id ? t("memory.page.undoing") : t("common.undo")}
              </button>
            ) : (
              <span className="shrink-0 pt-0.5 text-[11.5px] text-ink-tertiary" title={row.revertUnavailableReason}>
                {t("memory.page.cantUndo")}
              </span>
            )}
          </div>
          {row.diff && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[12px] text-ink-secondary hover:text-ink">
                {t("memory.page.diff", { added: row.added, removed: row.removed })}
              </summary>
              <pre className="mt-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-2.5 font-mono text-[11.5px] leading-relaxed text-ink">
                {row.diff}
              </pre>
            </details>
          )}
        </div>
      ))}
    </>
  );
}

export function MemoryUpkeepRows({ enabled, status, tidying, onToggle, onTidy, now }: {
  enabled: boolean;
  status: UpkeepStatus | null;
  tidying: boolean;
  onToggle: () => void;
  onTidy: () => void;
  now?: number;
}) {
  const noticed = noticedCount(status?.lastCapture);
  const noticedWhen = status?.lastCapture ? relativeTime(status.lastCapture.at, now) : "";
  return (
    <>
      <div className={cn(rowCls, "flex items-start gap-3")}>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-ink">{t("memory.upkeep.title")}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{t("memory.upkeep.hint")}</p>
        </div>
        <Switch checked={enabled} aria-label={t("memory.upkeep.title")} onClick={onToggle} />
      </div>
      {enabled && (
        <div data-memory-tidy className={cn(rowCls, "flex items-center gap-3")}>
          <div className="min-w-0 flex-1 text-[12px] leading-snug text-ink-tertiary">
            {status && !status.modelSteps && <p className="mb-0.5 text-ink-secondary">{t("memory.upkeep.basic")}</p>}
            <p>
              {status?.lastTidy
                ? t("memory.upkeep.last", { when: relativeTime(status.lastTidy.at, now), summary: tidySummary(status.lastTidy).toLowerCase() })
                : t("memory.upkeep.never")}
            </p>
            {noticed > 0 && (
              <p>{noticed === 1 ? t("memory.upkeep.noticedOne", { when: noticedWhen }) : t("memory.upkeep.noticedMany", { count: noticed, when: noticedWhen })}</p>
            )}
          </div>
          <button type="button" className={cn(pillCls, "shrink-0")} disabled={tidying} onClick={onTidy}>
            {tidying ? t("memory.upkeep.tidying") : t("memory.upkeep.tidy")}
          </button>
        </div>
      )}
    </>
  );
}

export function MemorySection({ bot, active = true, onClose }: { bot: Bot; active?: boolean; onClose: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const { dispatch } = useStore();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [journal, setJournal] = useState<MemoryJournalRow[] | null>(null);
  const [upkeep, setUpkeep] = useState<UpkeepStatus | null>(null);
  const [view, setView] = useState<"home" | "logs">("home");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);
  const [changesAll, setChangesAll] = useState(false);
  const header = useRef<HTMLDivElement | null>(null);
  const backButton = useRef<HTMLButtonElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const screen = editing ? `note:${editing.path}` : view;

  const refresh = async () => {
    const [nextOverview, nextJournal, nextUpkeep] = await Promise.all([
      fetchMemoryOverview(bot.id),
      fetchMemoryJournal(bot.id),
      fetchUpkeepStatus(bot.id).catch(() => null),
    ]);
    setOverview(nextOverview);
    setJournal(nextJournal);
    setUpkeep(nextUpkeep);
  };

  const open = async (path: string, template?: string) => {
    setError(null);
    setNotice(null);
    setConflict(null);
    setSavedDraft(null);
    setJustSaved(false);
    try {
      const doc = await fetchMemoryDoc(bot.id, path);
      const fresh = !doc.exists && template !== undefined;
      setEditing({
        path: doc.path,
        text: fresh ? template : doc.text,
        hash: doc.hash,
        dirty: fresh,
        readOnly: doc.path.startsWith("memory/log/"),
        exists: doc.exists,
      });
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError(null);
    refresh().catch((e: unknown) => {
      if (!cancelled) setError(errorText(e));
    });
    if (editing && !editing.dirty) void open(editing.path);
    return () => {
      cancelled = true;
    };
  }, [active, bot.id]);

  useEffect(() => {
    if (!active) return;
    const field = editor.current;
    if (editing && !editing.exists && field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    } else {
      backButton.current?.focus({ preventScroll: true });
    }
    header.current?.scrollIntoView?.({ block: "nearest" });
  }, [screen, active]);

  const closeEditor = () => {
    setEditing(null);
    setConflict(null);
    setSavedDraft(null);
    setJustSaved(false);
    setError(null);
  };

  const back = () => {
    if (editing) {
      if (editing.dirty && !window.confirm(t("memory.page.discardConfirm", { name: noteLabel(editing.path) }))) return;
      closeEditor();
      return;
    }
    setError(null);
    setNotice(null);
    if (view === "logs") setView("home");
    else onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    back();
  };

  const save = async (expectedHash: string) => {
    if (!editing || saving) return;
    const { path, text: sent } = editing;
    setSaving(true);
    setError(null);
    try {
      const result = await saveMemoryDoc(bot.id, path, sent, expectedHash);
      if (!result.ok) {
        setConflict({ current: result.current, currentHash: result.currentHash });
        return;
      }
      setConflict(null);
      setSavedDraft(null);
      setOverview(result.overview);
      setEditing((current) => {
        if (!current || current.path !== path) return current;
        return current.text === sent
          ? { ...current, text: result.doc.text, hash: result.doc.hash, dirty: false, exists: true }
          : { ...current, hash: result.doc.hash, exists: true };
      });
      setJustSaved(true);
      setJournal(await fetchMemoryJournal(bot.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const reloadFromConflict = () => {
    if (!conflict || !editing) return;
    setSavedDraft(editing.text);
    setEditing({ ...editing, text: conflict.current, hash: conflict.currentHash, dirty: false, exists: true });
    setConflict(null);
  };

  const discard = () => {
    if (!editing) return;
    if (editing.exists) void open(editing.path);
    else closeEditor();
  };

  const remove = async () => {
    if (!editing) return;
    if (!window.confirm(t("memory.page.deleteConfirm", { name: noteLabel(editing.path) }))) return;
    setError(null);
    try {
      const { overview: next } = await deleteMemoryDoc(bot.id, editing.path);
      setOverview(next);
      closeEditor();
      setJournal(await fetchMemoryJournal(bot.id));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const createNote = (input: string): boolean => {
    const name = topicFileName(input);
    if (!name) {
      setError(t("memory.page.badName"));
      return false;
    }
    void open(`memory/${name}`, topicTemplate(name));
    return true;
  };

  const revert = async (row: MemoryJournalRow) => {
    setReverting(row.id);
    setError(null);
    setNotice(null);
    try {
      const result = await revertMemoryChange(bot.id, row.id);
      setOverview(result.overview);
      setJournal(await fetchMemoryJournal(bot.id));
      setNotice(t("memory.page.restored", { name: noteLabel(row.path) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReverting(null);
    }
  };

  const openLocation = async (target: MemoryOpenTarget) => {
    setError(null);
    setNotice(null);
    try {
      await openMemoryLocation(bot.id, target);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const toggleUpkeep = () => {
    const enabled = bot.memoryUpkeep === false;
    dispatch({ type: "updateBot", botId: bot.id, patch: { memoryUpkeep: enabled } });
    setUpkeep((current) => (current ? { ...current, enabled } : current));
  };

  const tidyNow = async () => {
    setTidying(true);
    setError(null);
    setNotice(null);
    try {
      const { report, overview: next } = await tidyMemoryNow(bot.id);
      setOverview(next);
      const [nextJournal, nextUpkeep] = await Promise.all([fetchMemoryJournal(bot.id), fetchUpkeepStatus(bot.id).catch(() => null)]);
      setJournal(nextJournal);
      if (nextUpkeep) setUpkeep(nextUpkeep);
      setNotice(`${tidySummary(report)}.${report.note ? ` ${report.note}` : ""}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setTidying(false);
    }
  };

  const title = editing ? noteLabel(editing.path) : view === "logs" ? t("memory.page.logs") : t("memory.simple.title");
  const deletable = editing !== null && editing.path !== MEMORY_INDEX && editing.exists;
  const changes = journal && !changesAll ? journal.slice(0, CHANGES_SHOWN) : journal;

  return (
    <div data-memory-page={editing ? "note" : view} onKeyDown={onKeyDown} className="flex flex-col gap-5">
      <div ref={header} className="-mb-1 flex items-center gap-1">
        <button
          ref={backButton}
          type="button"
          data-memory-back
          onClick={back}
          aria-label={t("memory.page.back")}
          title={t("memory.page.back")}
          className={cn(iconButtonCls, "-ml-1.5")}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{title}</h3>
        {deletable && (
          <button
            type="button"
            data-memory-delete
            onClick={() => void remove()}
            aria-label={t("memory.page.delete", { name: title })}
            title={t("memory.page.delete", { name: title })}
            className={cn(iconButtonCls, "hover:text-danger")}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {error && <p role="alert" className="-mt-2 px-1 text-[12.5px] text-danger">{error}</p>}
      {notice && <p role="status" className="-mt-2 px-1 text-[12.5px] text-ink-secondary">{notice}</p>}

      {editing ? (
        <>
          {conflict && (
            <ConflictNotice botName={bot.name} busy={saving} onReload={reloadFromConflict} onOverwrite={() => void save(conflict.currentHash)} />
          )}
          {editing.path === MEMORY_INDEX && overview && <MemoryGauge index={overview.index} />}
          <textarea
            ref={editor}
            data-memory-editor
            value={editing.text}
            readOnly={editing.readOnly}
            aria-label={title}
            placeholder={editing.path === MEMORY_INDEX ? t("memory.page.mainPlaceholder", { name: bot.name }) : t("memory.page.notePlaceholder")}
            onChange={(event) => {
              const text = event.target.value;
              setJustSaved(false);
              setEditing((current) => (current ? { ...current, text, dirty: true } : current));
            }}
            className="min-h-[280px] w-full resize-y rounded-xl bg-card px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
          {editing.readOnly ? (
            <p className="-mt-2 px-1 text-[12px] text-ink-tertiary">{t("memory.page.readOnly", { name: bot.name })}</p>
          ) : (
            <div className="-mt-2 flex items-center gap-2">
              <button type="button" data-memory-save onClick={() => void save(editing.hash)} disabled={saving || !editing.dirty} className={pillCls}>
                {saving ? t("memory.page.saving") : justSaved && !editing.dirty ? t("memory.page.saved") : t("common.save")}
              </button>
              {editing.dirty && (
                <button type="button" data-memory-discard onClick={discard} disabled={saving} className={quietCls}>
                  {t("memory.page.discard")}
                </button>
              )}
            </div>
          )}
          {savedDraft !== null && (
            <div data-memory-draft>
              <p className="mb-1 px-1 text-[12px] text-ink-secondary">{t("memory.page.draft")}</p>
              <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
                {savedDraft}
              </pre>
              <button type="button" className={cn(quietCls, "mt-1")} onClick={() => setSavedDraft(null)}>
                {t("memory.page.dismissDraft")}
              </button>
            </div>
          )}
        </>
      ) : view === "logs" ? (
        <MemoryLogs logs={overview?.logs ?? []} botName={bot.name} onOpen={(path) => void open(path)} />
      ) : (
        <>
          {overview && capacityStatus(overview.index).level !== "ok" && <MemoryGauge index={overview.index} />}
          {overview ? (
            <MemoryNotes index={overview.index} topics={overview.topics} onOpen={(path) => void open(path)} onCreate={createNote} />
          ) : (
            !error && <p className="px-1 text-[12.5px] text-ink-tertiary">{t("memory.page.loading")}</p>
          )}
          <section>
            <h4 className={groupLabelCls}>{t("memory.page.changes")}</h4>
            <div className={cardCls}>
              <MemoryJournalList rows={changes} botName={bot.name} reverting={reverting} onRevert={(row) => void revert(row)} />
              {journal && journal.length > CHANGES_SHOWN && (
                <button type="button" onClick={() => setChangesAll((open) => !open)} className={moreCls}>
                  {changesAll ? t("memory.simple.fewer") : t("memory.simple.all", { count: journal.length })}
                </button>
              )}
            </div>
          </section>
          <section>
            <h4 className={groupLabelCls}>{t("memory.page.more")}</h4>
            <div className={cardCls}>
              {bot.memoryEnabled !== false && (
                <MemoryUpkeepRows
                  enabled={bot.memoryUpkeep !== false}
                  status={upkeep}
                  tidying={tidying}
                  onToggle={toggleUpkeep}
                  onTidy={() => void tidyNow()}
                />
              )}
              {overview && overview.logs.length > 0 && (
                <button type="button" data-memory-logs onClick={() => setView("logs")} className={navRowCls}>
                  <CalendarDays size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t("memory.page.logs")}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">{overview.logs.length}</span>
                  <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
                </button>
              )}
              <button
                type="button"
                data-memory-open="folder"
                title={overview?.workspacePath}
                onClick={() => void openLocation("folder")}
                className={navRowCls}
              >
                <FolderOpen size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{fileManagerLabel(capabilities.host.platform)}</span>
                <ExternalLink size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
              </button>
              <button type="button" data-memory-open="obsidian" onClick={() => void openLocation("obsidian")} className={navRowCls}>
                <BookOpen size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t("memory.page.obsidian")}</span>
                <ExternalLink size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
