import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadState } from "./process-reaper.ts";

const HOUR_MS = 60 * 60 * 1000;
export const CLOUD_TABS_CDP_PORT = 9339;
export const TAB_IDLE_HOURS = 6;
export const TAB_SWEEP_MS = 5 * 60 * 1000;
export const TABS_MARKER = "<<laterdog-tabs>>";
export const TAB_TRACKED_TOOLS: ReadonlySet<string> = new Set(["click", "drag", "key_press", "type_text", "open_url"]);
const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
const DEVTOOLS = `http://127.0.0.1:${CLOUD_TABS_CDP_PORT}/json`;

export interface Target { id: string; url: string }
export interface Owner { botId: string; threadId: string }
export interface TrackedTab extends Owner { url: string; openedAt: number }
export interface BoxTabs {
  tabs: Record<string, TrackedTab>;
  users: Record<string, Owner>;
  focused?: string;
}
export type TabLedger = Record<string, BoxTabs>;
export type TabCloseReason = "task closed" | "task gone" | "task idle";

const listScript = `curl -s -m 2 ${DEVTOOLS}/list 2>/dev/null || true`;
const userKey = (owner: Owner) => `${owner.botId}/${owner.threadId}`;

export function withTabListing(command: string): string {
  return `${command}\n__laterdog_rc=$?; printf '\\n%s\\n' '${TABS_MARKER}'; ${listScript}; exit $__laterdog_rc`;
}

export function parseTargets(text: string): Target[] | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, type, url } = entry as Record<string, unknown>;
    return type === "page" && typeof id === "string" && TARGET_ID.test(id) && typeof url === "string" ? [{ id, url }] : [];
  });
}

export function splitTabListing(stdout: string): { stdout: string; targets: Target[] | null } {
  const mark = `\n${TABS_MARKER}\n`;
  const at = stdout.lastIndexOf(mark);
  if (at === -1) return { stdout, targets: null };
  return { stdout: stdout.slice(0, at), targets: parseTargets(stdout.slice(at + mark.length)) };
}

export function recordTabs(ledger: TabLedger, boxId: string, owner: Owner | null, targets: readonly Target[], now = Date.now()): void {
  const box = (ledger[boxId] ??= { tabs: {}, users: {} });
  if (owner) box.users[userKey(owner)] = { botId: owner.botId, threadId: owner.threadId };
  const live = new Set(targets.map((target) => target.id));
  const gone = Object.entries(box.tabs).filter(([id]) => !live.has(id));
  const tabs: Record<string, TrackedTab> = {};
  for (const target of targets) {
    const known = box.tabs[target.id];
    if (known) {
      tabs[target.id] = { ...known, url: target.url };
      continue;
    }
    const restored = gone.findIndex(([, tab]) => tab.url === target.url);
    if (restored !== -1) {
      const [[, tab]] = gone.splice(restored, 1) as [[string, TrackedTab]];
      tabs[target.id] = tab;
    } else if (owner) {
      tabs[target.id] = { botId: owner.botId, threadId: owner.threadId, url: target.url, openedAt: now };
    }
  }
  const focused = targets[0]?.id;
  if (focused && owner && tabs[focused]) tabs[focused] = { ...tabs[focused], botId: owner.botId, threadId: owner.threadId };
  box.tabs = tabs;
  box.focused = focused;
}

export function tabCloseReason(state: ThreadState, now = Date.now(), idleHours = TAB_IDLE_HOURS): TabCloseReason | null {
  if (!state.exists) return "task gone";
  if (state.busy) return null;
  if (state.closed) return "task closed";
  return state.lastActiveAt !== null && state.lastActiveAt < now - idleHours * HOUR_MS ? "task idle" : null;
}

export function tabsToClose(box: BoxTabs, thread: (botId: string, threadId: string) => ThreadState, now = Date.now()): { id: string; url: string; reason: TabCloseReason }[] {
  const boxInUse = Object.values(box.users).some((user) => thread(user.botId, user.threadId).busy);
  return Object.entries(box.tabs).flatMap(([id, tab]) => {
    if (boxInUse && id === box.focused) return [];
    const reason = tabCloseReason(thread(tab.botId, tab.threadId), now);
    return reason ? [{ id, url: tab.url, reason }] : [];
  });
}

export function closeTabsScript(ids: readonly string[]): string {
  const safe = ids.filter((id) => TARGET_ID.test(id));
  return [...safe.map((id) => `curl -s -m 2 ${DEVTOOLS}/close/${id} >/dev/null 2>&1`), "sleep 0.3", listScript].join("; ");
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
