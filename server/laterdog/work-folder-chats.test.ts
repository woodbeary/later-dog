import { join } from "node:path";
import { expect, it } from "vitest";
import { workFolderChat, workFolderChats, workFolderChatsInSlices, type WorkFolderChatsDeps } from "./work-folder-chats.ts";

const base = (): WorkFolderChatsDeps => ({
  workspacesDir: "/synthetic/task-workspaces",
  bots: [{ id: "dog", threadId: "main", tasks: [] }],
  groups: [],
  thread: () => ({ exists: true, busy: false, closed: false, lastActiveAt: 123 }),
  atWork: () => false,
});

it("keeps known default and additional chats without reading their local folders", () => {
  const deps = base();
  deps.bots = [{ id: "dog", threadId: "main", tasks: [{ threadId: "task", title: "Work", createdAt: 0, resumeCursors: {} }] }];
  expect(workFolderChats(deps).map(chat => chat.dir)).toEqual(["main", "task"].map(id => join(deps.workspacesDir, "dog", id)));
});

it("keeps each known member's shared and guest default and additional chats", () => {
  const deps = base();
  deps.bots = [...deps.bots, { id: "other", threadId: "own", tasks: [] }];
  deps.groups = [{ threadId: "room", memberIds: ["dog", "other", "removed"], tasks: [{ threadId: "room-task", title: "Guest work", createdAt: 0 }] }];
  expect(workFolderChats(deps).map(chat => chat.dir)).toEqual([
    ["dog", "main"], ["other", "own"], ["dog", "room"], ["dog", "room-task"], ["other", "room"], ["other", "room-task"],
  ].map(([bot, thread]) => join(deps.workspacesDir, bot!, thread!)));
});

it("retains the saved closed state for a known chat", () => {
  const deps = base();
  deps.thread = () => ({ exists: true, busy: false, closed: true, lastActiveAt: 123 });
  expect(workFolderChats(deps)).toEqual([{ dir: join(deps.workspacesDir, "dog", "main"), busy: false, closed: true, lastActiveAt: 123 }]);
});

it("does not invent chats for deleted metadata or unknown folders", () => {
  const deps = base();
  deps.thread = () => ({ exists: false, busy: false, closed: false, lastActiveAt: null });
  expect(workFolderChats(deps)).toEqual([]);
  deps.bots = [];
  expect(workFolderChats(deps)).toEqual([]);
});

it.each(["thread", "other work"])("preserves the existing %s busy decision", source => {
  const deps = base();
  deps.thread = () => ({ exists: true, busy: source === "thread", closed: false, lastActiveAt: 123 });
  deps.atWork = () => source === "other work";
  expect(workFolderChats(deps)[0]?.busy).toBe(true);
});

it("deduplicates default and task pointers", () => {
  const deps = base();
  deps.groups = [{ threadId: "main", memberIds: ["dog"], tasks: [{ threadId: "main", title: "Same chat", createdAt: 0 }] }];
  expect(workFolderChats(deps)).toHaveLength(1);
});

it.each(["bots", "groups"])("defers the sweep when %s ownership metadata is damaged", name => {
  const deps = Object.assign(base(), { damaged: [{ name }] });
  expect(() => workFolderChats(deps)).toThrow(/chat.*read/i);
});

it("builds the same chat list in short slices, handing the server back between them, and finds one chat without building the list", async () => {
  const deps = base();
  deps.bots = Array.from({ length: 40 }, (_, i) => ({ id: `dog${i}`, threadId: `main${i}`, tasks: [{ threadId: `task${i}`, title: "Work", createdAt: 0, resumeCursors: {} }] }));
  const slow = deps.thread;
  deps.thread = (botId, threadId) => { const until = performance.now() + 1; while (performance.now() < until); return slow(botId, threadId); };
  let passes = 0;
  const sliced = await workFolderChatsInSlices(deps, async () => { passes += 1; });
  expect(sliced).toEqual(workFolderChats(deps));
  expect(passes).toBeGreaterThan(2);
  let looked = 0;
  deps.thread = (botId, threadId) => { looked += 1; return slow(botId, threadId); };
  expect(workFolderChat(deps, join(deps.workspacesDir, "dog7", "task7"))).toEqual({ dir: join(deps.workspacesDir, "dog7", "task7"), busy: false, closed: false, lastActiveAt: 123 });
  expect(looked).toBe(1);
});
