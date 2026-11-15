import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatTempDir, chatTempRoot, usedBy } from "./chat-temp.ts";
import { emptyTempAfterTurn } from "./home-upkeep.ts";

function root() {
  return chatTempRoot(mkdtempSync(join(tmpdir(), "upkeep-")));
}

function counting() {
  let reads = 0;
  const sweep = () => {
    reads += 1;
    return { atWork: () => false, engineAlive: () => true, inUse: usedBy([], []) };
  };
  return { sweep, reads: () => reads };
}

describe("emptying a chat's temp folder when its turn ends", () => {
  it("reads no processes when the folder is empty or missing", () => {
    const temp = root();
    mkdirSync(chatTempDir(temp, "chat-a"), { recursive: true });
    const { sweep, reads } = counting();
    const lines: string[] = [];
    emptyTempAfterTurn(temp, "chat-a", sweep, (line) => lines.push(line));
    emptyTempAfterTurn(temp, "chat-missing", sweep, (line) => lines.push(line));
    expect(reads()).toBe(0);
    expect(lines).toEqual([]);
    expect(existsSync(chatTempDir(temp, "chat-a"))).toBe(true);
  });

  it("reads them once and clears what nothing uses when the folder has entries", () => {
    const temp = root();
    const dir = chatTempDir(temp, "chat-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scratch.txt"), "x");
    const { sweep, reads } = counting();
    const lines: string[] = [];
    emptyTempAfterTurn(temp, "chat-a", sweep, (line) => lines.push(line));
    expect(reads()).toBe(1);
    expect(existsSync(join(dir, "scratch.txt"))).toBe(false);
    expect(lines).toHaveLength(1);
  });
});
