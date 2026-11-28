import { afterEach, expect, it, vi } from "vitest";

import { autoVerdict } from "../auto-approve.ts";
import { alwaysAsks } from "../laterdog/always-asks.ts";
import { TASK_WORKSPACES_DIR } from "../laterdog/dog-mounts.ts";
import { permissionCommand, permissionLaunchCwd } from "./permission-command.ts";

afterEach(() => { vi.unstubAllEnvs(); });

it("gives a Bash ask on a mounted folder its working folder at once, before the real path has resolved", () => {
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
  const cwd = `${TASK_WORKSPACES_DIR}/dog/never-answers-${process.pid}`;
  const launch = permissionLaunchCwd(cwd);
  expect(launch()).toBe(cwd);
  expect(permissionCommand("ls", launch())).toEqual({ command: "ls", cwd });
});

it("never shows a Full-access dog a card for a shell command, with or without its working folder", () => {
  for (const command of [{ command: "ls -la", cwd: "/x" }, undefined]) {
    expect(autoVerdict("full", "Bash").approve).not.toBeNull();
    expect(alwaysAsks({ tool: "Bash", command: command?.command, input: { command: "rm -rf build" } }, () => ({ cwd: command?.cwd, workspaceRoots: [], fullAccess: true }))).toBeNull();
  }
});
