import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadState } from "./process-reaper.ts";

const HOUR_MS = 60 * 60 * 1000;
export const CLOUD_TABS_CDP_PORT = 9339;
export const TAB_IDLE_HOURS = 6;
export const TAB_SWEEP_MS = 5 * 60 * 1000;
export const MAX_TABS_PER_COMPUTER = 4;
export const TABS_MARKER = "<<laterdog-tabs>>";
export const TABS_BEFORE_MARKER = "<<laterdog-tabs-before>>";
export const TAB_TRACKED_TOOLS: ReadonlySet<string> = new Set(["click", "drag", "key_press", "type_text", "open_url"]);
const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
const DEVTOOLS = `http://127.0.0.1:\${LATERDOG_PAGE_CDP_PORT:-${CLOUD_TABS_CDP_PORT}}/json`;

export interface Target { id: string; url: string }
export interface Owner { botId: string; threadId: string }
interface Seen { url: string; openedAt: number; usedAt?: number }
export interface DogTab extends Owner, Seen { keep?: true }
export interface PersonTab extends Seen { person: true }
export type FoundTab = Seen;
export type TrackedTab = DogTab | PersonTab | FoundTab;
export interface BoxTabs {
  tabs: Record<string, TrackedTab>;
  users: Record<string, Owner>;
  focused?: string;
  control?: Record<string, number>;
  browserDown?: true;
}
export type TabLedger = Record<string, BoxTabs>;
export type TabCloseReason = "task closed" | "task gone" | "task idle" | "turn over" | "too many tabs";
export interface Opened { id: string; keep?: boolean }
export interface TabChoice { target?: string; avoid: string[] }

export const listTabsScript = `curl -s -m 2 ${DEVTOOLS}/list 2>/dev/null || true`;
const userKey = (owner: Owner) => `${owner.botId}/${owner.threadId}`;
export const isDogTab = (tab: TrackedTab): tab is DogTab => "botId" in tab;
export const isPersonTab = (tab: TrackedTab): tab is PersonTab => "person" in tab;
const lastUsed = (tab: TrackedTab) => tab.usedAt ?? tab.openedAt;
const sameOwner = (tab: TrackedTab, owner: Owner) => isDogTab(tab) && tab.botId === owner.botId && tab.threadId === owner.threadId;

export function withTabListing(command: string): string {
  return `${listTabsScript}; printf '\\n%s\\n' '${TABS_BEFORE_MARKER}'\n${command}\n__laterdog_rc=$?; printf '\\n%s\\n' '${TABS_MARKER}'; ${listTabsScript}; exit $__laterdog_rc`;
}

export function parseTargets(text: string): Target[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end < start) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, type, url } = entry as Record<string, unknown>;
    return type === "page" && typeof id === "string" && TARGET_ID.test(id) && typeof url === "string" ? [{ id, url }] : [];
  });
}

export function splitTabListing(stdout: string): { stdout: string; before: Target[] | null; targets: Target[] | null } {
  let rest = stdout;
  let before: Target[] | null = null;
  const opening = `\n${TABS_BEFORE_MARKER}\n`;
  const ran = rest.indexOf(opening);
  if (ran !== -1) {
    before = parseTargets(rest.slice(0, ran));
    rest = rest.slice(ran + opening.length);
  }
  const mark = `\n${TABS_MARKER}\n`;
  const at = rest.lastIndexOf(mark);
  if (at === -1) return { stdout: rest, before, targets: null };
  return { stdout: rest.slice(0, at), before, targets: parseTargets(rest.slice(at + mark.length)) };
}

export interface RecordOptions {
  before?: readonly Target[] | null;
  opened?: Opened | null;
  adopt?: Owner | null;
  person?: boolean;
}

export function recordTabs(ledger: TabLedger, boxId: string, owner: Owner | null, targets: readonly Target[], now = Date.now(), options: RecordOptions = {}): void {
  const box = (ledger[boxId] ??= { tabs: {}, users: {} });
  const user = owner ?? options.adopt ?? null;
  if (user) box.users[userKey(user)] = { botId: user.botId, threadId: user.threadId };
  delete box.browserDown;
  const live = new Set(targets.map((target) => target.id));
  const gone = Object.entries(box.tabs).filter(([id]) => !live.has(id));
  const earlier = options.before ? new Set(options.before.map((target) => target.id)) : null;
  const finder = options.adopt === undefined ? owner : options.adopt;
  const newcomer = (target: Target): TrackedTab => {
    const opener = owner && (earlier === null || !earlier.has(target.id)) ? owner : null;
    if (opener) return { botId: opener.botId, threadId: opener.threadId, url: target.url, openedAt: now };
    if (options.person) return { person: true, url: target.url, openedAt: now };
    return finder ? { botId: finder.botId, threadId: finder.threadId, url: target.url, openedAt: now } : { url: target.url, openedAt: now };
  };
  const tabs: Record<string, TrackedTab> = {};
  for (const target of targets) {
    const known = box.tabs[target.id];
    if (known) {
      tabs[target.id] = { ...known, url: target.url };
      continue;
    }
    const openedNow = owner !== null && earlier !== null && !earlier.has(target.id);
    const restored = openedNow ? -1 : gone.findIndex(([, tab]) => tab.url === target.url);
    if (restored !== -1) {
      const [[, tab]] = gone.splice(restored, 1) as [[string, TrackedTab]];
      tabs[target.id] = { ...tab, url: target.url };
      continue;
    }
    tabs[target.id] = newcomer(target);
  }
  const focused = targets[0]?.id;
  if (focused && owner && tabs[focused]) {
    const front = tabs[focused]!;
    const stays = isPersonTab(front) || (isDogTab(front) && front.keep === true);
    tabs[focused] = stays ? { ...front, usedAt: now } : { url: front.url, openedAt: front.openedAt, botId: owner.botId, threadId: owner.threadId, usedAt: now };
  }
  const opened = options.opened;
  const prior = opened && owner ? tabs[opened.id] : undefined;
  if (opened && owner && prior) {
    const keep = opened.keep === true || (sameOwner(prior, owner) && (prior as DogTab).keep === true);
    tabs[opened.id] = { url: prior.url, openedAt: prior.openedAt, botId: owner.botId, threadId: owner.threadId, usedAt: now, ...(keep ? { keep: true as const } : {}) };
  }
  box.tabs = tabs;
  box.focused = focused;
}

export function noteBrowserDown(ledger: TabLedger, boxId: string): void {
  const box = ledger[boxId];
  if (box) box.browserDown = true;
}

export function tabToReuse(box: BoxTabs | undefined, owner: Owner, thread: (botId: string, threadId: string) => ThreadState): TabChoice {
  if (!box) return { avoid: [] };
  const entries = Object.entries(box.tabs);
  const busyElsewhere = (tab: TrackedTab) => isDogTab(tab) && !sameOwner(tab, owner) && thread(tab.botId, tab.threadId).busy;
  const avoid = entries.filter(([, tab]) => isPersonTab(tab) || (isDogTab(tab) && tab.keep === true) || busyElsewhere(tab)).map(([id]) => id);
  const own = entries.filter(([, tab]) => sameOwner(tab, owner) && !(tab as DogTab).keep).sort(([, a], [, b]) => lastUsed(b) - lastUsed(a));
  if (own[0]) return { target: own[0][0], avoid };
  const front = box.focused ? box.tabs[box.focused] : undefined;
  if (front && box.focused && !avoid.includes(box.focused)) return { target: box.focused, avoid };
  return { avoid };
}

export function tabCloseReason(state: ThreadState, now = Date.now(), idleHours = TAB_IDLE_HOURS, keep = false): TabCloseReason | null {
  if (!state.exists) return "task gone";
  if (state.busy) return null;
  if (state.closed) return "task closed";
  if (keep) return null;
  return state.lastActiveAt !== null && state.lastActiveAt < now - idleHours * HOUR_MS ? "task idle" : null;
}

export function tabsAfterTurn(box: BoxTabs, owner: Owner): string[] {
  return Object.entries(box.tabs)
    .filter(([id, tab]) => id !== box.focused && sameOwner(tab, owner) && !(tab as DogTab).keep)
    .map(([id]) => id);
}

export function tabsOverCap(box: BoxTabs, cap = MAX_TABS_PER_COMPUTER, closing: readonly string[] = []): string[] {
  const entries = Object.entries(box.tabs);
  const extra = entries.length - closing.filter((id) => box.tabs[id]).length - cap;
  if (extra <= 0) return [];
  const rank = (tab: TrackedTab) => (isDogTab(tab) ? 0 : 1);
  return entries
    .map(([id, tab], place) => ({ id, tab, place }))
    .filter(({ id, tab }) => id !== box.focused && !closing.includes(id) && !isPersonTab(tab) && !(isDogTab(tab) && tab.keep))
    .sort((a, b) => rank(a.tab) - rank(b.tab) || lastUsed(a.tab) - lastUsed(b.tab) || b.place - a.place)
    .slice(0, extra)
    .map(({ id }) => id);
}

export function tabsToClose(box: BoxTabs, thread: (botId: string, threadId: string) => ThreadState, now = Date.now(), cap = MAX_TABS_PER_COMPUTER): { id: string; url: string; reason: TabCloseReason }[] {
  const boxInUse = Object.values(box.users).some((user) => thread(user.botId, user.threadId).busy);
  const doomed = Object.entries(box.tabs).flatMap(([id, tab]) => {
    if (!isDogTab(tab)) return [];
    const state = thread(tab.botId, tab.threadId);
    const reason = tabCloseReason(state, now, TAB_IDLE_HOURS, tab.keep === true);
    if (reason) return boxInUse && id === box.focused ? [] : [{ id, url: tab.url, reason }];
    return !state.busy && !tab.keep && id !== box.focused ? [{ id, url: tab.url, reason: "turn over" as const }] : [];
  });
  const over = tabsOverCap(box, cap, doomed.map((tab) => tab.id));
  return [...doomed, ...over.map((id) => ({ id, url: box.tabs[id]!.url, reason: "too many tabs" as const }))];
}

export function closeTabsScript(ids: readonly string[]): string {
  const safe = ids.filter((id) => TARGET_ID.test(id));
  return [...safe.map((id) => `curl -s -m 2 ${DEVTOOLS}/close/${id} >/dev/null 2>&1`), "sleep 0.3", listTabsScript].join("; ");
}

export function forgetTabs(ledger: TabLedger, boxId: string, ids: readonly string[]): void {
  const box = ledger[boxId];
  if (box) for (const id of ids) delete box.tabs[id];
}

export function forgetUsers(ledger: TabLedger, keep: (owner: Owner) => boolean): void {
  for (const box of Object.values(ledger)) {
    for (const [key, user] of Object.entries(box.users)) if (!keep(user)) delete box.users[key];
  }
}

export function loadTabLedger(file: string): TabLedger {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as TabLedger : {};
  } catch {
    return {};
  }
}

export function saveTabLedger(file: string, ledger: TabLedger): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {}
}
