import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_WATCH_IGNORED } from "./dev-watch.ts";

const ignored = (path: string) => DEV_WATCH_IGNORED.some((pattern) => matchesGlob(path, pattern));

describe("the dev server's file watcher", () => {
  it("leaves worktrees inside the checkout alone, so adding or removing one never reloads the open window", () => {
    expect(ignored("/Users/me/code/dog/.claude/worktrees/tasks-list/tsconfig.json")).toBe(true);
    expect(ignored("/Users/me/code/dog/.claude/worktrees/tasks-list/src/App.tsx")).toBe(true);
    expect(ignored("/Users/me/code/dog/.codex/worktrees/native/vite.config.ts")).toBe(true);
  });

  it("still watches the app itself", () => {
    expect(ignored("/Users/me/code/dog/src/App.tsx")).toBe(false);
    expect(ignored("/Users/me/code/dog/tsconfig.json")).toBe(false);
    expect(ignored("/Users/me/code/dog/shared/cloud-task.ts")).toBe(false);
  });
});
