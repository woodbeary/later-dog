import { expect, it } from "vitest";
import { createMountedFolderGate, MountedFolderStalled } from "./mounted-folder-gate.ts";
import { prepareTurnFolders } from "./turn-folders.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("prepares three turns' folders at once on a slow mount while the server keeps answering", async () => {
  const gate = createMountedFolderGate({ probe: () => pause(300), answerMs: 50, active: () => true });
  const made: string[] = [];
  const makeDir = async (path: string) => { await pause(400); made.push(path); };
  let worst = 0;
  let last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 20); last = now; }, 20);
  const waits: unknown[] = [];
  try {
    await Promise.all(["a", "b", "c"].map((dog) => prepareTurnFolders({
      workspace: `/data/.laterdog/workspaces/${dog}`, task: `/data/.laterdog/task-workspaces/${dog}/chat`, budgetMs: 5_000,
      gate, active: true, makeDir, noticeMs: 100, onWait: (wait) => waits.push(wait),
    })));
  } finally { clearInterval(tick); }
  expect(worst).toBeLessThan(100);
  expect(made.sort()).toEqual([
    "/data/.laterdog/task-workspaces/a/chat", "/data/.laterdog/task-workspaces/b/chat", "/data/.laterdog/task-workspaces/c/chat",
    "/data/.laterdog/workspaces/a/memory", "/data/.laterdog/workspaces/b/memory", "/data/.laterdog/workspaces/c/memory",
  ]);
  expect(waits.filter((wait) => (wait as { waiting: boolean }).waiting)).toHaveLength(3);
});

it("gives up on a folder that never comes back within the wake budget and does nothing off the mounted layout", async () => {
  const gate = createMountedFolderGate({ probe: async () => ({}), active: () => true });
  await expect(prepareTurnFolders({ workspace: "/data/.laterdog/workspaces/stuck", budgetMs: 80, gate, active: true, makeDir: () => new Promise(() => {}) }))
    .rejects.toBeInstanceOf(MountedFolderStalled);
  let touched = false;
  await prepareTurnFolders({ workspace: "/x", budgetMs: 80, gate, active: false, makeDir: async () => { touched = true; } });
  expect(touched).toBe(false);
});
