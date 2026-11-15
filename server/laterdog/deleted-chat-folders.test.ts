import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diskLadder } from "./disk-ladder.ts";
import { DELETED_FOLDER_KEEP_MS, removeDeletedChatFolders, setAsideChatFolders, startDeletedChatFolders } from "./deleted-chat-folders.ts";

function home() {
  const root = mkdtempSync(join(tmpdir(), "deleted-chats-"));
  const workspaces = join(root, "task-workspaces");
  const aside = join(root, "deleted-chat-folders");
  const work = (dog: string, chat: string) => {
    mkdirSync(join(workspaces, dog, chat, "app"), { recursive: true });
    writeFileSync(join(workspaces, dog, chat, "app", "index.ts"), `${dog} ${chat}\n`);
  };
  return { root, workspaces, aside, work };
}

describe("a deleted chat's work folder", () => {
  it("is set aside at once for every dog that worked in the chat, and other chats stay", () => {
    const { workspaces, aside, work } = home();
    work("dog-a", "chat-1");
    work("dog-b", "chat-1");
    work("dog-a", "chat-2");
    const moved = setAsideChatFolders("chat-1", workspaces, aside, 1000);
    expect(moved.sort()).toEqual([join(aside, "dog-a", "chat-1-1000"), join(aside, "dog-b", "chat-1-1000")]);
    expect(readFileSync(join(aside, "dog-b", "chat-1-1000", "app", "index.ts"), "utf8")).toBe("dog-b chat-1\n");
    expect(existsSync(join(workspaces, "dog-a", "chat-1"))).toBe(false);
    expect(existsSync(join(workspaces, "dog-a", "chat-2", "app", "index.ts"))).toBe(true);
    expect(existsSync(join(workspaces, "dog-b"))).toBe(false);
  });

  it("is removed seven days later and not before", () => {
    const { workspaces, aside, work } = home();
    work("dog-a", "chat-1");
    setAsideChatFolders("chat-1", workspaces, aside, 1000);
    expect(removeDeletedChatFolders(aside, 1000 + DELETED_FOLDER_KEEP_MS - 1).removed).toEqual([]);
    const done = removeDeletedChatFolders(aside, 1000 + DELETED_FOLDER_KEEP_MS);
    expect(done.removed).toEqual([join(aside, "dog-a", "chat-1-1000")]);
    expect(done.freed).toBeGreaterThan(0);
    expect(readdirSync(aside)).toEqual([]);
  });

  it("follows the store's deletion of a chat and leaves names it does not trust alone", () => {
    const { workspaces, aside, work } = home();
    work("dog-a", "chat-1");
    let listener: (change: { type: string; threadId?: string }) => void = () => {};
    const lines: string[] = [];
    const stop = startDeletedChatFolders({ changes: (next) => { listener = next; }, workspaces, aside, log: (line) => lines.push(line) });
    listener({ type: "thread", threadId: "chat-1" });
    listener({ type: "thread.deleted", threadId: "../dog-a" });
    expect(existsSync(join(workspaces, "dog-a", "chat-1"))).toBe(true);
    listener({ type: "thread.deleted", threadId: "chat-1" });
    stop();
    expect(existsSync(join(workspaces, "dog-a", "chat-1"))).toBe(false);
    expect(readdirSync(join(aside, "dog-a"))).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it("goes first when the disk reaches the emergency step", () => {
    const { workspaces, aside, work } = home();
    work("dog-a", "chat-1");
    setAsideChatFolders("chat-1", workspaces, aside, Date.now());
    const lines: string[] = [];
    const ladder = diskLadder({
      disk: () => ({ totalBytes: 100, freeBytes: 2 }),
      chats: () => [],
      live: () => [],
      sweepTemp: () => ({ removed: [], freed: 0 }),
      pruneCaches: () => 0,
      dropDeleted: () => removeDeletedChatFolders(aside, Date.now(), 0).freed,
      log: (line) => lines.push(line),
    });
    ladder.climb();
    expect(readdirSync(aside)).toEqual([]);
    expect(lines.join("\n")).toMatch(/removed deleted chats' folders/);
  });
});
