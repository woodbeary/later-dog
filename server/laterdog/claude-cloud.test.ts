import { describe, expect, it, vi } from "vitest";
import { ClaudeCloudAdapter, sessionBranch } from "./claude-cloud.ts";
import { SubmissionUnknown, type JobContext } from "./codex-cloud.ts";
import type { CommandRunner, CommandResult } from "./command.ts";

const profile = { id: "claude", label: "Claude", backend: "claude-cloud" as const, routineTokenEnv: "CLAUDE_ROUTINE_TOKEN_FIXTURE" };
const env = { CLAUDE_ROUTINE_TOKEN_FIXTURE: "sk-ant-oat01-fixture" };
const context: JobContext = { jobId: "11111111-1111-4111-8111-111111111111", repository: "fixture/repo", sourceRef: "laterdog/input/11111111-1111-4111-8111-111111111111", baseSha: "a".repeat(40), createdAt: new Date(0).toISOString() };
const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
const fired = () => new Response(JSON.stringify({ type: "routine_fire", claude_code_session_id: "session_abc", claude_code_session_url: "https://claude.ai/code/session_abc" }), { status: 200 });

describe("Claude Code cloud adapter", () => {
  it("fires the repository's routine with the pinned ref and scratch branch in the payload", async () => {
    const fetchMock = vi.fn(async () => fired());
    const adapter = new ClaudeCloudAdapter(profile, { fetch: fetchMock as unknown as typeof fetch, env });
    await expect(adapter.submit("trig_fixture", context.sourceRef!, "Do the thing", context)).resolves.toEqual({ taskId: "session_abc", taskUrl: "https://claude.ai/code/session_abc" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/claude_code/routines/trig_fixture/fire");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-ant-oat01-fixture"); expect(headers["anthropic-beta"]).toBe("experimental-cc-routine-2026-04-01"); expect(headers["anthropic-version"]).toBe("2023-06-01");
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    expect(text).toContain("Do the thing"); expect(text).toContain(`ref: ${context.sourceRef}`); expect(text).toContain(`push-to: ${sessionBranch(context.jobId)}`);
  });
  it("treats 4xx as definite failure, 5xx and network errors as uncertain, and a missing token as a configuration error", async () => {
    const denied = new ClaudeCloudAdapter(profile, { fetch: (async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad token" } }), { status: 401 })) as unknown as typeof fetch, env });
    await expect(denied.submit("trig_fixture", context.sourceRef!, "x", context)).rejects.toThrow(/401.*bad token/);
    const outage = new ClaudeCloudAdapter(profile, { fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch, env });
    await expect(outage.submit("trig_fixture", context.sourceRef!, "x", context)).rejects.toBeInstanceOf(SubmissionUnknown);
    const network = new ClaudeCloudAdapter(profile, { fetch: (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch, env });
    await expect(network.submit("trig_fixture", context.sourceRef!, "x", context)).rejects.toBeInstanceOf(SubmissionUnknown);
    const unconfigured = new ClaudeCloudAdapter(profile, { fetch: (async () => fired()) as unknown as typeof fetch, env: {} });
    await expect(unconfigured.submit("trig_fixture", context.sourceRef!, "x", context)).rejects.toThrow(/CLAUDE_ROUTINE_TOKEN_FIXTURE/);
    expect((await unconfigured.doctor()).authenticated).toBe(false);
    await expect(new ClaudeCloudAdapter(profile, { env }).submit("", context.sourceRef!, "x", context)).rejects.toThrow(/routine ID/);
  });
  it("infers completion from the pushed branch and reports a session that never pushes as failed after the timeout", async () => {
    let branch: string | undefined;
    const run: CommandRunner = async (_binary, args) => args[1]?.includes("/branches/")
      ? (branch ? ok(JSON.stringify({ commit: { sha: branch } })) : { stdout: "", stderr: "gh: Branch not found (HTTP 404)", exitCode: 1, timedOut: false })
      : ok("");
    let now = Date.parse(context.createdAt) + 60_000;
    const adapter = new ClaudeCloudAdapter(profile, { run, env, now: () => now, timeoutMs: 10 * 60_000 });
    expect(await adapter.inspect("session_abc", context)).toBe("running");
    branch = context.baseSha; expect(await adapter.inspect("session_abc", context)).toBe("running");
    branch = "b".repeat(40); expect(await adapter.inspect("session_abc", context)).toBe("ready");
    branch = undefined; now += 11 * 60_000; expect(await adapter.inspect("session_abc", context)).toBe("failed");
    await expect(adapter.inspect("session_abc")).rejects.toThrow(/job context/);
  });
  it("collects the compare diff between the pinned commit and the session branch, keeping the trailing newline", async () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
    const run: CommandRunner = async (_binary, args) => {
      expect(args).toEqual(["api", "-H", "Accept: application/vnd.github.diff", `repos/fixture/repo/compare/${context.baseSha}...${sessionBranch(context.jobId)}`]); return ok(patch);
    };
    expect(await new ClaudeCloudAdapter(profile, { run, env }).collect("session_abc", context)).toBe(`${patch}\n`);
  });
  it("validates session identities and states its limitations", () => {
    const adapter = new ClaudeCloudAdapter(profile, { env });
    expect(adapter.describeTask("session_abc").taskUrl).toBe("https://claude.ai/code/session_abc");
    expect(() => adapter.describeTask("task_abc")).toThrow(/Invalid Claude session/);
    expect(adapter.capabilities.continuation).toBe(false); expect(adapter.capabilities.cancellation).toBe(false); expect(adapter.capabilities.limitation).toMatch(/no session status/i);
  });
});
