export type AppShortcut =
  | { kind: "search" }
  | { kind: "newDog" }
  | { kind: "settings" }
  | { kind: "connectApps" }
  | { kind: "focusComposer" }
  | { kind: "toggleSidebar" }
  | { kind: "dogPanel" }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "previousDog" }
  | { kind: "nextDog" }
  | { kind: "dogAt"; index: number };

export type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "defaultPrevented"> & {
  target?: EventTarget | null;
};

function keyName(event: ShortcutEvent): string {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (event.code?.startsWith("Key")) return event.code.slice(3).toLowerCase();
  if (event.code?.startsWith("Digit")) return event.code.slice(5);
  if (event.code === "Comma") return ",";
  if (event.code === "BracketLeft") return "[";
  if (event.code === "BracketRight") return "]";
  return event.key.toLowerCase();
}

function typingTarget(target: EventTarget | null | undefined): boolean {
  const element = target as { isContentEditable?: boolean; closest?: (selector: string) => unknown } | null | undefined;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.isContentEditable || element.closest("input, textarea, select, [contenteditable=true]"));
}

export function appShortcut(event: ShortcutEvent, isMac: boolean): AppShortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = keyName(event);
  if (!mod) {
    if (!event.altKey || event.shiftKey || event.metaKey || event.ctrlKey || typingTarget(event.target)) return null;
    if (event.key === "ArrowUp") return { kind: "previousDog" };
    if (event.key === "ArrowDown") return { kind: "nextDog" };
    return null;
  }
  if (event.altKey) return !event.shiftKey && key === "b" ? { kind: "dogPanel" } : null;
  if (event.shiftKey) {
    if (key === "f") return { kind: "search" };
    if (key === "," || key === "i") return { kind: "dogPanel" };
    if (key === "m") return { kind: "connectApps" };
    return null;
  }
  if (key === "k") return { kind: "search" };
  if (key === "n") return { kind: "newDog" };
  if (key === ",") return { kind: "settings" };
  if (key === "i") return { kind: "focusComposer" };
  if (key === "b") return { kind: "toggleSidebar" };
  if (key === "[") return { kind: "back" };
  if (key === "]") return { kind: "forward" };
  if (/^[1-9]$/.test(key)) return { kind: "dogAt", index: Number(key) - 1 };
  return null;
}

export function stepThrough<T>(order: readonly T[], current: T | undefined, step: -1 | 1): T | undefined {
  if (order.length === 0) return undefined;
  const index = current === undefined ? -1 : order.indexOf(current);
  if (index < 0) return step === 1 ? order[0] : order.at(-1);
  return order[(index + step + order.length) % order.length];
}

export interface SelectionHistory {
  entries: string[];
  index: number;
}

export const EMPTY_HISTORY: SelectionHistory = { entries: [], index: -1 };

export function visitSelection(history: SelectionHistory, id: string, limit = 50): SelectionHistory {
  if (!id || history.entries[history.index] === id) return history;
  const entries = [...history.entries.slice(0, history.index + 1), id].slice(-limit);
  return { entries, index: entries.length - 1 };
}

export function moveInHistory(
  history: SelectionHistory,
  step: -1 | 1,
  exists: (id: string) => boolean,
): { history: SelectionHistory; id: string } | null {
  for (let index = history.index + step; index >= 0 && index < history.entries.length; index += step) {
    const id = history.entries[index]!;
    if (exists(id)) return { history: { ...history, index }, id };
  }
  return null;
}
