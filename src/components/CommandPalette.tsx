import { useEffect, useRef, useState } from "react";
import { Command, MessageSquare, Puzzle, Search } from "lucide-react";
import { api, useStore, type Action, type AppState, type Bot, type Group } from "@/state/store";
import { rankByName } from "@/lib/palette-rank";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { inOneConversation, type SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";
import { appIconUrl } from "@/lib/app-icons";
import { MCP_CONNECTORS, connectorMatchesSearch, type McpConnector } from "@/lib/mcp-connectors";
import { setSidebarDensity, loadSidebarDensity } from "@/lib/sidebar-preferences";
import { BotAvatar } from "./Avatar";
import { ShortcutHint } from "./ShortcutHint";

export const SEARCH_APP_LIMIT = 5;

export interface SearchCommand {
  id: string;
  label: LocaleKey;
  shortcut: string;
  run: (dispatch: (action: Action) => void, state: AppState) => void;
}

export const SEARCH_COMMANDS: readonly SearchCommand[] = [
  { id: "new-dog", label: "search.command.newDog", shortcut: "new-bot", run: (dispatch) => dispatch({ type: "toggleNewBot", open: true }) },
  { id: "settings", label: "search.command.settings", shortcut: "open-settings", run: (dispatch) => dispatch({ type: "toggleAppSettings", open: true }) },
  { id: "connect-apps", label: "search.command.connectApps", shortcut: "connect-apps", run: (dispatch) => dispatch({ type: "togglePlugins", open: true, surface: "apps" }) },
  {
    id: "dog-details",
    label: "search.command.dogDetails",
    shortcut: "dog-details",
    run: (dispatch, state) => {
      if (state.bots.some((bot) => bot.id === state.selectedId)) dispatch({ type: "toggleSettings" });
    },
  },
  {
    id: "toggle-sidebar",
    label: "search.command.toggleSidebar",
    shortcut: "toggle-sidebar",
    run: () => setSidebarDensity(loadSidebarDensity() === "icons" ? "comfortable" : "icons"),
  },
  { id: "shortcuts", label: "search.command.shortcuts", shortcut: "shortcuts-cheat-sheet", run: (dispatch) => dispatch({ type: "toggleShortcuts", open: true }) },
];

export function matchingCommands(query: string): SearchCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SEARCH_COMMANDS.filter((command) => t(command.label).toLowerCase().includes(q));
}

export function matchingApps(query: string): McpConnector[] {
  const q = query.trim();
  if (!q) return [];
  return rankByName(MCP_CONNECTORS.filter((connector) => connectorMatchesSearch(connector, q)), q).slice(0, SEARCH_APP_LIMIT);
}

export function searchDogs(bots: readonly Bot[], query: string): Bot[] {
  const ranked = rankByName(bots, query);
  return [...ranked.filter((bot) => !bot.hidden), ...(query.trim() ? ranked.filter((bot) => bot.hidden) : [])];
}

type SearchEntry =
  | { kind: "bot"; bot: Bot }
  | { kind: "room"; group: Group }
  | { kind: "app"; app: McpConnector }
  | { kind: "command"; command: SearchCommand }
  | { kind: "message"; hit: SearchHit };

export function CommandPalette() {
  const { state, dispatch } = useStore();
  const open = state.searchOpen;
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const close = () => dispatch({ type: "toggleSearch", open: false });

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMessageHits([]);
    setCursor(0);
  }, [open]);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!open || !q) {
      setMessageHits([]);
      return;
    }
    setMessageHits([]);
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => alive && setMessageHits(result.hits ?? []))
        .catch(() => alive && setMessageHits([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, messageHits]);

  if (!open) return null;

  const bots = searchDogs(state.bots, q);
  const rooms = rankByName(state.groups.filter((group) => !group.dm), q);
  const apps = matchingApps(q);
  const commands = matchingCommands(q);
  const shownHits = q ? messageHits.filter((hit) => inOneConversation(hit, state)) : [];
  const entries: SearchEntry[] = [
    ...bots.map((bot): SearchEntry => ({ kind: "bot", bot })),
    ...rooms.map((group): SearchEntry => ({ kind: "room", group })),
    ...apps.map((app): SearchEntry => ({ kind: "app", app })),
    ...commands.map((command): SearchEntry => ({ kind: "command", command })),
    ...shownHits.map((hit): SearchEntry => ({ kind: "message", hit })),
  ];
  const selected = entries.length ? Math.min(cursor, entries.length - 1) : 0;

  const activate = async (entry: SearchEntry) => {
    close();
    if (entry.kind === "message") {
      try {
        await landOnSearchHit(entry.hit, state, dispatch);
      } catch (error) {
        dispatch({ type: "reportError", error });
      }
    } else if (entry.kind === "app") {
      dispatch({ type: "togglePlugins", open: true, surface: "apps" });
    } else if (entry.kind === "command") {
      entry.command.run(dispatch, state);
    } else {
      dispatch({ type: "select", id: entry.kind === "bot" ? entry.bot.id : entry.group.id });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(entries.length ? (selected + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(entries.length ? (selected - 1 + entries.length) % entries.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void activate(entry);
    }
  };

  let index = -1;
  const row = (key: string, entry: SearchEntry, children: React.ReactNode, twoLine = false) => {
    index += 1;
    const at = index;
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={at === selected}
        ref={at === selected ? selectedRef : undefined}
        onClick={() => void activate(entry)}
        onMouseMove={() => setCursor(at)}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left",
          twoLine && "flex-col items-stretch gap-0.5",
          at === selected ? "bg-raised" : "hover:bg-raised/50",
        )}
      >
        {children}
      </button>
    );
  };
  const heading = (label: string) => (
    <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-ink-secondary">{label}</div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-[14vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("search.title")}
        className="flex max-h-[min(520px,72vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.aria")}
            role="combobox"
            aria-expanded={entries.length > 0}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <kbd className="shrink-0 rounded-md border border-hairline/40 px-1.5 py-0.5 text-[11px] text-ink-secondary">esc</kbd>
        </div>
        <div role="listbox" aria-label={t("search.title")} className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
              {q ? t("search.noMatch", { query }) : t("search.empty")}
            </div>
          )}
          {bots.length > 0 && heading(t("search.section.dogs"))}
          {bots.map((bot) => row(`bot:${bot.id}`, { kind: "bot", bot }, (
            <>
              <BotAvatar bot={bot} state="idle" size={24} animated={false} />
              <span className="truncate text-[14px] text-ink">{bot.name}</span>
              {bot.title && <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">{bot.title}</span>}
              {bot.hidden && (
                <span data-search-hidden className="ml-auto shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-ink-secondary">{t("search.hiddenTag")}</span>
              )}
            </>
          )))}
          {rooms.length > 0 && heading(t("search.section.groupChats"))}
          {rooms.map((group) => row(`room:${group.id}`, { kind: "room", group }, (
            <>
              <MessageSquare size={16} className="shrink-0 text-ink-secondary" />
              <span className="truncate text-[14px] text-ink">{group.name}</span>
            </>
          )))}
          {apps.length > 0 && heading(t("search.section.apps"))}
          {apps.map((app) => {
            const icon = appIconUrl(app.domain);
            return row(`app:${app.id}`, { kind: "app", app }, (
              <>
                {icon ? <img src={icon} alt="" className="size-6 shrink-0 rounded-md" /> : <Puzzle size={16} className="shrink-0 text-ink-secondary" />}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] text-ink">{app.name}</span>
                  <span className="truncate text-[12px] text-ink-secondary">{t(app.description)}</span>
                </span>
              </>
            ));
          })}
          {commands.length > 0 && heading(t("search.section.commands"))}
          {commands.map((command) => row(`command:${command.id}`, { kind: "command", command }, (
            <>
              <Command size={16} className="shrink-0 text-ink-secondary" />
              <span className="flex-1 truncate text-[14px] text-ink">{t(command.label)}</span>
              <ShortcutHint id={command.shortcut} />
            </>
          )))}
          {shownHits.length > 0 && heading(t("search.section.messages"))}
          {shownHits.map((hit) => {
            const before = hit.snippet.slice(0, hit.matchStart);
            const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
            const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
            return row(`msg:${hit.threadId}:${hit.messageId}`, { kind: "message", hit }, (
              <>
                <span className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
                  <MessageSquare size={13} className="shrink-0 text-ink-secondary" />
                  {hit.from ?? hit.name}
                </span>
                <span className="line-clamp-2 text-[12.5px] text-ink-secondary">
                  {before}<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{match}</mark>{after}
                </span>
              </>
            ), true);
          })}
        </div>
      </div>
    </div>
  );
}
