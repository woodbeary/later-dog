import { describe, expect, it } from "vitest";
import { HeavyCommandGuard, heavyCommandKind, preToolUseDecision } from "./heavy-commands.ts";

describe("heavy commands on a shared Cloud home", () => {
  it("recognises installs, builds, suites, containers and media work, even after cd, env or a pipe", () => {
    for (const command of [
      "pnpm install",
      "pnpm i --frozen-lockfile",
      "cd site && npm ci",
      "yarn",
      "bun add zod",
      "CI=1 pnpm test",
      "npm run build 2>&1 | tail -20",
      "pnpm -s typecheck",
      "npx tsc --noEmit",
      "npx playwright test",
      "next build",
      "pip install -r requirements.txt",
      "python3 -m pip install numpy",
      "uv sync",
      "cargo build --release",
      "docker build -t app .",
      "ffmpeg -i in.mov out.mp4",
      "time pnpm build",
      "(cd web; pnpm install)",
    ]) expect(heavyCommandKind(command), command).not.toBeNull();
  });

  it("leaves quick commands, version checks and single test files alone", () => {
    for (const command of [
      "ls -la",
      "git status",
      "pnpm --version",
      "node --version",
      "npx vitest run src/one.test.ts",
      "pytest tests/test_one.py",
      "cat package.json | grep build",
      "echo 'pnpm install'",
      "rg 'npm test' docs",
      "pnpm why react",
      "npm view react version",
    ]) expect(heavyCommandKind(command), command).toBeNull();
  });

  it("refuses a heavy command once per chat and lets the same command through when the dog runs it again", () => {
    let now = 1_000;
    const guard = new HeavyCommandGuard(() => now);
    const first = guard.check("thread-a", "pnpm install");
    expect(first).toContain("run_on_computer");
    expect(first).toContain("run the same command here again");
    expect(guard.check("thread-b", "pnpm install")).not.toBeNull();
    expect(guard.check("thread-a", "pnpm   install")).toBeNull();
    expect(guard.check("thread-a", "pnpm install")).not.toBeNull();
    now += 31 * 60_000;
    expect(guard.check("thread-a", "pnpm install")).not.toBeNull();
    expect(guard.check("thread-a", "git status")).toBeNull();
  });
});

describe("the PreToolUse decision a Cloud home gives the engine", () => {
  const payload = (command: unknown, tool = "Bash") => ({ tool_name: tool, tool_input: { command } });

  it("denies a heavy shell command with the reason the engine shows the dog", () => {
    const decision = preToolUseDecision(new HeavyCommandGuard(), { active: true, threadId: "t", payload: payload("pnpm install") });
    expect(decision).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(String(decision?.permissionDecisionReason)).toContain("run_on_computer");
  });

  it("stays out of the way off a Cloud home, for other tools, quick commands and malformed input", () => {
    const guard = new HeavyCommandGuard();
    expect(preToolUseDecision(guard, { active: false, threadId: "t", payload: payload("pnpm install") })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: payload("pnpm install", "Read") })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: payload("git status") })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: payload(42) })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: {} })).toBeNull();
  });
});
