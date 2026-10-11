import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudTaskStep } from "../../shared/cloud-task.ts";
import { ACTIVITY_SCRIPT, AUTO_SETUP_SCRIPT, WATCH_SCRIPT } from "./cloud-task-files.ts";

const TOKEN = `sk-ant-oat01-${"z".repeat(95)}`;
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "laterdog-task-files-")); roots.push(root);
  mkdirSync(join(root, "task")); mkdirSync(join(root, "work"));
  return root;
}

const stream = (home: string) => [
  { type: "system", subtype: "init", model: "claude" },
  { type: "assistant", message: { content: [{ type: "text", text: `Looking at the repo. The token is ${TOKEN}.` }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test\necho second line" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${home}/work/src/a.ts`, old_string: "a", new_string: "b" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Read the code", status: "completed" }, { content: "Fix it", status: "in_progress" }] } }] } },
  { type: "assistant", parent_tool_use_id: "toolu_sub", message: { content: [{ type: "text", text: "a helper's own words" }] } },
  { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "\n  Error: 2 tests failed\nmore" }] }] } },
  { type: "user", message: { content: [{ type: "tool_result", is_error: false, content: "fine" }] } },
  { type: "result", is_error: false, result: "All done.", num_turns: 7, duration_ms: 1234 },
].map((event) => JSON.stringify(event)).join("\n") + "\nnot json\n";

describe("the progress logger on a task's computer", () => {
  it("turns Claude's stream into readable steps and blanks the Claude token", () => {
    const root = home();
    writeFileSync(join(root, "task", "activity.mjs"), ACTIVITY_SCRIPT);
    const run = spawnSync(process.execPath, [join(root, "task", "activity.mjs")], { input: stream(root), env: { HOME: root, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, encoding: "utf8" });
    expect(run.status).toBe(0);
    const log = readFileSync(join(root, "task", "activity.jsonl"), "utf8");
    expect(log).not.toContain(TOKEN);
    const steps = log.trim().split("\n").map((line) => cloudTaskStep(JSON.parse(line)));
    expect(steps.map((step) => step && { ...step, t: 0 })).toEqual([
      { t: 0, k: "say", text: "Looking at the repo. The token is [redacted]." },
      { t: 0, k: "tool", tool: "Bash", detail: "pnpm test" },
      { t: 0, k: "tool", tool: "Edit", detail: "src/a.ts" },
      { t: 0, k: "plan", todos: [{ text: "Read the code", status: "completed" }, { text: "Fix it", status: "in_progress" }] },
      { t: 0, k: "error", text: "Error: 2 tests failed" },
      { t: 0, k: "done", ok: true, text: "All done.", turns: 7, ms: 1234 },
    ]);
  });

  it("keeps reading after a bad line and never fails the pipeline", () => {
    const root = home();
    writeFileSync(join(root, "task", "activity.mjs"), ACTIVITY_SCRIPT);
    const run = spawnSync(process.execPath, [join(root, "task", "activity.mjs")], { input: "{\n[]\nnull\n" + JSON.stringify({ type: "assistant", message: { content: null } }) + "\n", env: { HOME: root }, encoding: "utf8" });
    expect(run.status).toBe(0);
  });
});

describe("the live view on a task's screen", () => {
  it("prints each step as it is written", async () => {
    const root = home();
    writeFileSync(join(root, "task", "watch.mjs"), WATCH_SCRIPT);
    const child = spawn(process.execPath, [join(root, "task", "watch.mjs")], { env: { HOME: root } });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    writeFileSync(join(root, "task", "activity.jsonl"), [
      { t: 1, k: "stage", stage: "clone" }, { t: 2, k: "tool", tool: "Bash", detail: "pnpm test" }, { t: 3, k: "done", ok: true, text: "Finished it." },
    ].map((step) => JSON.stringify(step)).join("\n") + "\n");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    child.kill();
    expect(output).toContain("Getting the code");
    expect(output).toContain("pnpm test");
    expect(output).toContain("Finished it.");
  });
});

describe("automatic project setup", () => {
  function fixture(files: string[], failing: string[] = []) {
    const root = home();
    const bin = join(root, "bin"); mkdirSync(bin);
    for (const name of ["pnpm", "yarn", "npm", "python3", "sudo"]) {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${join(root, "calls.log")}"\n${failing.includes(name) ? "exit 3" : "exit 0"}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    for (const file of files) writeFileSync(join(root, "work", file), "");
    writeFileSync(join(root, "setup.sh"), AUTO_SETUP_SCRIPT);
    const run = spawnSync("/bin/bash", [join(root, "setup.sh")], { cwd: join(root, "work"), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root }, encoding: "utf8" });
    let calls = "";
    try { calls = readFileSync(join(root, "calls.log"), "utf8"); } catch { calls = ""; }
    return { status: run.status, calls: calls.trim().split("\n").filter(Boolean) };
  }

  it("installs with the lockfile's own package manager", () => {
    expect(fixture(["pnpm-lock.yaml", "package.json"]).calls).toEqual(["sudo corepack enable", "pnpm install --frozen-lockfile"]);
    expect(fixture(["yarn.lock"]).calls).toEqual(["sudo corepack enable", "yarn install --frozen-lockfile"]);
    expect(fixture(["package-lock.json"]).calls).toEqual(["npm ci"]);
    expect(fixture(["package.json"]).calls).toEqual(["npm install"]);
    expect(fixture(["requirements.txt"]).calls).toEqual(["python3 -m pip install --user --break-system-packages -r requirements.txt"]);
    expect(fixture([])).toEqual({ status: 0, calls: [] });
  });

  it("reports a failed install without stopping at the first manager", () => {
    const failed = fixture(["package-lock.json", "requirements.txt"], ["npm"]);
    expect(failed.status).toBe(3);
    expect(failed.calls).toEqual(["npm ci", "python3 -m pip install --user --break-system-packages -r requirements.txt"]);
  });
});
