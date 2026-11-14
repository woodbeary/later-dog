import { describe, expect, it } from "vitest";
import { heldLock, skipped } from "../runtime/sync.mjs";
import { saveSkips } from "../../../../server/laterdog/save-skips.ts";

const NAMES = [
  "node_modules", ".cache", ".tmp", ".npm", ".pnpm-store", "Cache", "Code Cache", "GPUCache", "ShaderCache", "Crashpad", ".Trash", "lost+found",
  ".oauth_refresh.lock", ".oauth_refresh.lock.owner", ".laterdog-restoring-abc", "db.sqlite-wal", "db.sqlite-shm", "db-journal",
  "held.lock", "notes.txt", ".git", "src", "cache", "node_modules2", "x.lock.txt",
];

describe("the server's copy of the save's skip rules", () => {
  it("skips exactly what the home's save skips, for files, links and folders", () => {
    for (const name of NAMES) {
      expect(saveSkips(name, "file"), `file ${name}`).toBe(skipped(name, "file"));
      expect(saveSkips(name, "link"), `link ${name}`).toBe(skipped(name, "link"));
      expect(saveSkips(name, "dir"), `dir ${name}`).toBe(skipped(name, "dir") || heldLock(name, "dir"));
    }
  });
});
