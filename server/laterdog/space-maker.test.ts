import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inUse, makeSpace } from "./space-maker.ts";

function fill(path: string, bytes = 64 * 1024) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "blob"), Buffer.alloc(bytes, 1));
}

function homeWithWork() {
  const home = mkdtempSync(join(tmpdir(), "space-maker-"));
  const workspaces = join(home, ".laterdog/task-workspaces");
  fill(join(home, "site/node_modules/react"));
  fill(join(home, "site/.next/cache"));
  fill(join(home, "reflow/app/node_modules/vite"));
  fill(join(workspaces, "dog/idle/repo/node_modules/a"));
  fill(join(workspaces, "dog/busy/repo/node_modules/b"));
  fill(join(home, ".npm/_cacache/content"));
  fill(join(home, ".cache/pip/http"));
  fill(join(home, ".cache/ms-playwright/chromium"));
  fill(join(home, ".claude/projects/chat"));
  writeFileSync(join(home, "site/page.tsx"), "export default 1");
  return { home, workspaces };
}

const proc = (cwd: string, argv: string) => ({ pid: 9, ppid: 1, cwd, argv });

describe("making space on a full Cloud home", () => {
  it("clears rebuildable folders and package caches nobody is using, and keeps everything a dog made", () => {
    const { home, workspaces } = homeWithWork();
    let pruned = false;
    const run = makeSpace({
      home,
      workspacesDir: workspaces,
      busyDirs: [join(workspaces, "dog/busy")],
      processes: () => [proc(join(home, "reflow/app"), "node vite"), proc(join(workspaces, "dog/idle"), "/usr/local/bin/claude --resume x")],
      pruneStore: () => { pruned = true; },
    });
    expect(run.cleared.map((path) => path.slice(home.length + 1)).sort()).toEqual([
      ".cache/pip",
      ".laterdog/task-workspaces/dog/idle/repo/node_modules",
      ".npm/_cacache",
      "site/.next",
      "site/node_modules",
    ]);
    expect(run.freed).toBeGreaterThan(0);
    expect(pruned).toBe(true);
    for (const kept of ["reflow/app/node_modules", ".laterdog/task-workspaces/dog/busy/repo/node_modules", ".cache/ms-playwright", ".claude/projects/chat", "site/page.tsx"]) expect(existsSync(join(home, kept))).toBe(true);
  });

  it("leaves package caches alone while an install is running", () => {
    const { home, workspaces } = homeWithWork();
    let pruned = false;
    const run = makeSpace({ home, workspacesDir: workspaces, busyDirs: [], processes: () => [proc(join(home, "elsewhere"), "pnpm install")], pruneStore: () => { pruned = true; } });
    expect(pruned).toBe(false);
    expect(existsSync(join(home, ".npm/_cacache"))).toBe(true);
    expect(run.cleared.some((path) => path.endsWith("site/node_modules"))).toBe(true);
  });

  it("counts a folder as in use when a busy chat owns it or a program runs in or names its project", () => {
    expect(inUse("/data/site/node_modules", [], [proc("/data/site/src", "node next dev")])).toBe(true);
    expect(inUse("/data/site/node_modules", [], [proc("/data", "node /data/site/server.js")])).toBe(true);
    expect(inUse("/data/site/node_modules", [], [proc("/data", "bash")])).toBe(false);
    expect(inUse("/w/dog/t/node_modules", ["/w/dog/t"], [])).toBe(true);
  });
});
