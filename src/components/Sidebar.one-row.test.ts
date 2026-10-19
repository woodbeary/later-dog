import { Children, createElement, isValidElement, type KeyboardEvent, type MemoExoticComponent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot, type Group } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});

import { BotContextMenu, BotListItem, botRowProps, GroupListItem, type BotRowProps } from "./Sidebar";

const bot: Bot = {
  id: "atlas", threadId: "last-selected", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: true,
  modelSelection: { instanceId: "fake", model: "test" }, messages: [],
  projects: [{ id: "private-folder", name: "Quiet folder" }],
  tasks: [
    { threadId: "last-selected", title: "Last selected conversation", createdAt: 1 },
    { threadId: "idle-history", title: "Idle history", createdAt: 2, projectId: "private-folder" },
    { threadId: "approval", title: "Review permission", createdAt: 3, busy: false, activity: "waiting-on-you", projectId: "private-folder" },
    { threadId: "working", title: "Running job", createdAt: 4, busy: true, activity: "working" },
    { threadId: "queued", title: "Next job", createdAt: 5 },
    { threadId: "unread", title: "Finished reply", createdAt: 6, unread: true },
  ],
};
const densities: SidebarDensity[] = ["comfortable", "icons"];
const botRow = (BotListItem as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type;
const rowProps = (density: SidebarDensity, candidate: Bot = bot) =>
  botRowProps({ ...initialState, ...fixture.state }, fixture.dispatch, candidate, { density, onMenu: vi.fn() });

type ElementProps = { children?: ReactNode; onClick?: (event: MouseEvent) => void; onKeyDown?: (event: KeyboardEvent) => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string, value: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (child.props[attribute] === value) return child;
    const found = findElement(child.props.children, attribute, value);
    if (found) return found;
  }
}

beforeEach(() => {
  fixture.state = { bots: [bot], selectedId: "other-bot", pendingQueued: { queued: [{ queueId: "q", text: "next" }] } };
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("HTMLInputElement", class {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("one row per dog", () => {
  it.each([
    { density: "comfortable", size: 32, spacing: ["gap-3", "py-2", "pl-2"] },
    { density: "icons", size: 44, spacing: ["justify-center", "px-1", "py-1.5"] },
  ] as const)("sizes the portrait and row spacing in $density density", ({ density, size, spacing }) => {
    for (const avatar of [{}, { avatarUrl: "/api/attachments/portrait.png", avatarCrop: "circle" as const }]) {
      let tree: ReactNode;
      function Capture() { tree = botRow(rowProps(density, { ...bot, ...avatar })); return tree; }
      const markup = renderToStaticMarkup(createElement(Capture));
      const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
      expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining([...spacing]));
      expect(markup).toContain(avatar.avatarUrl
        ? `width="${size}" height="${size}"`
        : `width="${size}px" height="${size}px"`);
    }
  });

  it.each(densities)("opens the dog's one conversation on mouse or keyboard in %s density", (density) => {
    let tree: ReactNode;
    function Capture() { tree = botRow(rowProps(density)); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
    row.props.onClick!({ type: "click", target: {} } as MouseEvent);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: bot.id });
    for (const key of ["Enter", " "]) {
      fixture.dispatch.mockClear();
      const preventDefault = vi.fn();
      row.props.onKeyDown!({ key, preventDefault } as unknown as KeyboardEvent);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: bot.id });
    }
  });

  it.each(densities)("shows no thread tree, folders, thread buttons or side activity for a dog with old extra tasks in %s density", (density) => {
    fixture.state.selectedId = bot.id;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density)));
    for (const gone of ["data-sidebar-thread-row", "data-sidebar-folder-row", "data-sidebar-activity-row", "Idle history", "Quiet folder", "Review permission", "New thread", "New folder", "Atlas threads"]) {
      expect(markup).not.toContain(gone);
    }
    expect(markup).toContain('aria-current="page"');
  });

  it("reads status and unread from the one conversation, not old extra tasks", () => {
    const quiet = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable")));
    expect(quiet).not.toContain('data-testid="waiting-dot"');
    expect(quiet).not.toContain('aria-label="Unread"');
    const current = {
      ...bot,
      tasks: bot.tasks!.map((task) => task.threadId === "last-selected" ? { ...task, activity: "waiting-on-you" as const, unread: true } : task),
    };
    const waiting = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", current)));
    expect(waiting).toContain('data-testid="waiting-dot"');
    expect(waiting).toContain('aria-label="Unread"');
  });

  it("marks the row queued only when the one conversation has a queued send", () => {
    expect(renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable")))).not.toContain("Queued");
    fixture.state.pendingQueued = { "last-selected": [{ queueId: "q", text: "next" }] };
    expect(renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable")))).toContain("Queued");
  });

  it("offers no thread or folder creation in the dog's menu", () => {
    const markup = renderToStaticMarkup(createElement(BotContextMenu, menuProps()));
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("New folder");
    expect(markup).toContain("Rename Dog");
  });
});

const menuProps = (botId = bot.id) => ({
  menu: { botId, x: 0, y: 0 }, onClose: vi.fn(), onHide: vi.fn(), onShow: vi.fn(), onRename: vi.fn(),
  onDelete: vi.fn(), onReplaceMainDog: vi.fn(), onMoveToSection: vi.fn(),
});
const menuLabels = (markup: string) => [...markup.matchAll(/role="menuitem"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)</g)].map((match) => match[1]);

describe("the dog's menu, like Grok Bot's", () => {
  it("lists Pin, Move to, Read or Unread, Rename, Copy ID, Hide from sidebar and Delete in that order", () => {
    fixture.state.bots = [{ ...bot, unread: false, tasks: undefined }];
    expect(menuLabels(renderToStaticMarkup(createElement(BotContextMenu, menuProps())))).toEqual([
      "Pin", "Move to", "Mark as Unread", "Rename Dog", "Copy conversation ID", "Hide from sidebar", "Delete",
    ]);
  });

  it("offers Mark as Read on an unread dog and marks it read without opening it", () => {
    const props = menuProps();
    fixture.state.bots = [{ ...bot, unread: true, tasks: undefined }];
    let tree: ReactNode;
    function Capture() { tree = (BotContextMenu as (p: typeof props) => ReactNode)(props); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    expect(menuLabels(markup)).toContain("Mark as Read");
    expect(menuLabels(markup)).not.toContain("Mark as Unread");
  });

  it("gives a hidden dog Show in sidebar instead of Pin, Move to and Hide, and keeps Delete", () => {
    fixture.state.bots = [{ ...bot, unread: false, tasks: undefined, hidden: true }];
    expect(menuLabels(renderToStaticMarkup(createElement(BotContextMenu, menuProps())))).toEqual([
      "Mark as Unread", "Rename Dog", "Copy conversation ID", "Show in sidebar", "Delete",
    ]);
  });

  it("lets a hidden main dog be shown again but never deleted", () => {
    fixture.state.bots = [{ ...bot, unread: false, tasks: undefined, hidden: true, chiefOfStaff: true }];
    const labels = menuLabels(renderToStaticMarkup(createElement(BotContextMenu, menuProps())));
    expect(labels).toContain("Show in sidebar");
    expect(labels).not.toContain("Delete");
  });
});

describe("one row per group chat", () => {
  it("lists no group threads and offers no new thread", () => {
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0, messages: [],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }, { threadId: "group-earlier", title: "Earlier planning", createdAt: 0 }],
    };
    fixture.state.selectedId = group.id;
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).not.toContain("data-sidebar-thread-row");
    expect(markup).not.toContain("Earlier planning");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("Planning threads");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Planning");
  });
});

describe("group preview", () => {
  it("resolves the cached author by id after a rename even when the old name is reused", () => {
    fixture.state.bots = [{ ...bot, name: "Scout" }, { ...bot, id: "replacement", name: "Atlas" }];
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" },
      bulletin: "", unread: false, createdAt: 0,
      messages: [{ id: "b1", role: "bot", kind: "text", text: "Plan drafted.", at: 2,
        from: { botId: "atlas", name: "Atlas", color: "green" } }],
    };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Scout: Plan drafted.");
    expect(markup).not.toContain("Atlas: Plan drafted.");
    expect(group.messages[0].from?.name).toBe("Atlas");
  });
  it("previews the last reply, not the digest receipt that follows it", () => {
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0,
      messages: [
        { id: "b1", role: "bot", kind: "text", text: "Plan drafted.", at: 2, from: { botId: "atlas", name: "Atlas", color: "green" } },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Group["messages"],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }],
    };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Atlas: Plan drafted.");
    expect(markup).not.toContain("[digest]");
  });

  it("previews a markdown reply as plain words", () => {
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0,
      messages: [
        { id: "b1", role: "bot", kind: "text", text: "### Plan\n\n1. **Draft** the [brief](https://example.com)\n2. Ship it", at: 2, from: { botId: "atlas", name: "Atlas", color: "green" } },
      ] as Group["messages"],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }],
    };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Atlas: Plan 1. Draft the brief 2. Ship it");
    expect(markup).not.toContain("###");
  });
});
