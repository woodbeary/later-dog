export interface ShortcutItem {
  id: string;
  description: string;
  macKeys: string[];
  winKeys: string[];
}

export interface ShortcutGroup {
  category: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    category: "Navigation",
    items: [
      { id: "search", description: "Search dogs, group chats, apps and messages", macKeys: ["⌘", "K"], winKeys: ["Ctrl", "K"] },
      { id: "focus-search", description: "Search (same as ⌘K)", macKeys: ["⌘", "⇧", "F"], winKeys: ["Ctrl", "Shift", "F"] },
      { id: "new-bot", description: "New dog", macKeys: ["⌘", "N"], winKeys: ["Ctrl", "N"] },
      { id: "jump-bot", description: "Go to the 1st–9th chat in the sidebar", macKeys: ["⌘", "1–9"], winKeys: ["Ctrl", "1–9"] },
      { id: "switch-bot", description: "Previous / next chat in the sidebar", macKeys: ["⌥", "↑ / ↓"], winKeys: ["Alt", "↑ / ↓"] },
      { id: "navigate-history", description: "Back / forward through chats you opened", macKeys: ["⌘", "[ / ]"], winKeys: ["Ctrl", "[ / ]"] },
      { id: "toggle-sidebar", description: "Collapse or expand the sidebar", macKeys: ["⌘", "B"], winKeys: ["Ctrl", "B"] },
      { id: "dog-details", description: "Show or hide the dog's details", macKeys: ["⌘", "⌥", "B"], winKeys: ["Ctrl", "Alt", "B"] },
      { id: "connect-apps", description: "Connect apps", macKeys: ["⌘", "⇧", "M"], winKeys: ["Ctrl", "Shift", "M"] },
      { id: "open-settings", description: "Settings", macKeys: ["⌘", ","], winKeys: ["Ctrl", ","] },
    ],
  },
  {
    category: "Chat",
    items: [
      { id: "focus-composer", description: "Go to the message box", macKeys: ["⌘", "I"], winKeys: ["Ctrl", "I"] },
      { id: "send-message", description: "Send message", macKeys: ["Return"], winKeys: ["Enter"] },
      { id: "new-line", description: "New line without sending", macKeys: ["⇧", "Return"], winKeys: ["Shift", "Enter"] },
      { id: "edit-last-message", description: "Edit your last message (when the message box is empty)", macKeys: ["↑"], winKeys: ["↑"] },
      { id: "quote-selection", description: "Quote the selected text in your reply", macKeys: ["⌘", "L"], winKeys: ["Ctrl", "L"] },
      { id: "find-conversation", description: "Find in conversation", macKeys: ["⌘", "F"], winKeys: ["Ctrl", "F"] },
      { id: "close-panel", description: "Close a menu, dialog or find bar", macKeys: ["Esc"], winKeys: ["Esc"] },
      { id: "shortcuts-cheat-sheet", description: "Keyboard shortcuts", macKeys: ["⌘", "/"], winKeys: ["Ctrl", "/"] },
    ],
  },
  {
    category: "Calls",
    items: [
      { id: "live-call-mute", description: "Mute or unmute a voice call", macKeys: ["⌘", "⇧", "M"], winKeys: ["Ctrl", "Shift", "M"] },
      { id: "live-call-hang-up", description: "Hang up a voice call", macKeys: ["⌘", "⇧", "H"], winKeys: ["Ctrl", "Shift", "H"] },
    ],
  },
  {
    category: "Sidebar",
    items: [
      { id: "reorder-section", description: "Move a section up or down (focus its heading)", macKeys: ["⌥", "↑ / ↓"], winKeys: ["Alt", "↑ / ↓"] },
    ],
  },
];

export function shouldOpenKeyboardShortcuts(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const helpKey = event.key === "?" && !event.metaKey && !event.ctrlKey;
  const helpChord = event.key === "/" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  if (!helpKey && !helpChord) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (
    target.isContentEditable || target.closest("input, textarea, select, dialog, [role=dialog]")
  ));
}

export function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.laterdog?.platform) {
    return window.laterdog.platform === "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

export function shortcutKeysForPlatform(
  item: ShortcutItem,
  isMac: boolean = isMacPlatform(),
): string[] {
  return isMac ? item.macKeys : item.winKeys;
}

export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  isMac: boolean = isMacPlatform(),
): ShortcutGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...groups];

  return groups
    .map((group) => {
      const filteredItems = group.items.filter((item) => {
        const keys = shortcutKeysForPlatform(item, isMac).join(" ").toLowerCase();
        return (
          item.description.toLowerCase().includes(normalized) ||
          group.category.toLowerCase().includes(normalized) ||
          keys.includes(normalized)
        );
      });
      return { ...group, items: filteredItems };
    })
    .filter((group) => group.items.length > 0);
}
