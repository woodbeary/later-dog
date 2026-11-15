import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatTempDir, chatTempName, chatTempRoot, emptyChatTemp, prepareChatTemp, sweepChatTemps, usedBy } from "./chat-temp.ts";

const nothingUsed = usedBy([], []);

function tempWith() {
  const base = mkdtempSync(join(tmpdir(), "chat-temp-"));
  const root = chatTempRoot(base);
  const dir = chatTempDir(root, "chat-a");
  mkdirSync(join(dir, "clone/.git/objects"), { recursive: true });
  writeFileSync(join(dir, "clone/.git/objects/pack"), Buffer.alloc(32 * 1024, 1));
  writeFileSync(join(dir, "notes.txt"), "scratch");
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server/out.log"), "still writing");
  return { base, root, dir };
}

describe("a temp folder for each chat", () => {
  it("is made private and given to the engine as its temp folder", () => {
    const base = mkdtempSync(join(tmpdir(), "chat-temp-"));
    const env = prepareChatTemp(chatTempRoot(base), "chat-a");
    expect(env).toEqual({ TMPDIR: join(base, "laterdog-chats", "chat-a"), TMP: env.TMPDIR, TEMP: env.TMPDIR });
    expect(statSync(env.TMPDIR!).mode & 0o777).toBe(0o700);
  });

  it("keeps every chat's folder inside the temp root whatever its id", () => {
    for (const id of ["../../etc", "..", "a/b", ""]) {
      expect(chatTempName(id)).not.toMatch(/\/|^\.\.?$/);
      expect(chatTempDir("/t/laterdog-chats", id).startsWith("/t/laterdog-chats/")).toBe(true);
    }
  });
});

describe("emptying a chat's temp folder when its turn ends", () => {
  it("removes what nobody is using", () => {
    const { dir } = tempWith();
    const cleared = emptyChatTemp(dir, nothingUsed);
    expect(cleared.removed.sort()).toEqual([join(dir, "clone"), join(dir, "notes.txt"), join(dir, "server")]);
    expect(cleared.freed).toBeGreaterThan(30 * 1024);
    expect(existsSync(dir)).toBe(true);
  });

  it("never removes what a live process has open, works in, or names", () => {
    const { dir } = tempWith();
    emptyChatTemp(dir, usedBy([join(dir, "server/out.log"), join(dir, "clone/.git")], [`node ${join(dir, "notes.txt")}`]));
    expect(readFileSync(join(dir, "server/out.log"), "utf8")).toBe("still writing");
    expect(existsSync(join(dir, "clone/.git/objects/pack"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("never follows a link out of the temp folder", () => {
    const { base, dir } = tempWith();
    const work = join(base, "workspace");
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src/index.ts"), "export {}");
    symlinkSync(work, join(dir, "link-to-work"));
    emptyChatTemp(dir, nothingUsed);
    expect(existsSync(join(dir, "link-to-work"))).toBe(false);
    expect(readFileSync(join(work, "src/index.ts"), "utf8")).toBe("export {}");
  });
});

describe("sweeping chat temp folders when disk runs short", () => {
  function two() {
    const { root, dir } = tempWith();
    const other = chatTempDir(root, "chat-b");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "big"), Buffer.alloc(16 * 1024, 1));
    return { root, dir, other };
  }

  it("never touches a chat where a turn is running", () => {
    const { root, dir, other } = two();
    sweepChatTemps(root, { atWork: (name) => name === "chat-a", engineAlive: () => false, inUse: nothingUsed });
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it("empties but keeps the folder of a chat whose engine is still alive, and removes the rest", () => {
    const { root, dir, other } = two();
    const swept = sweepChatTemps(root, { atWork: () => false, engineAlive: (name) => name === "chat-a", inUse: nothingUsed });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(false);
    expect(existsSync(other)).toBe(false);
    expect(swept.freed).toBeGreaterThan(40 * 1024);
  });

  it("keeps a folder that still holds something in use", () => {
    const { root, dir } = two();
    sweepChatTemps(root, { atWork: () => false, engineAlive: () => false, inUse: usedBy([join(dir, "server/out.log")], []) });
    expect(existsSync(join(dir, "server/out.log"))).toBe(true);
  });
});
