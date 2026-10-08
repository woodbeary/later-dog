import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexCloudAdapter, SubmissionUnknown } from "./codex-cloud.ts";
import type { CommandRunner } from "./command.ts";

describe("native Codex Cloud adapter",() => {
  it("uses the source ref, one attempt, subscription auth and argument arrays",async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "https://chatgpt.com/codex/tasks/task_fixture",stderr: "",exitCode: 0,timedOut: false });
    const adapter = new CodexCloudAdapter({ id: "account-a",label: "A",codexHome: "/private/account-a" },run);
    await expect(adapter.submit("env_a","laterdog/input/fixture","Implement $(no-shell) `literal` text")).resolves.toMatchObject({ taskId: "task_fixture" });
    expect(run.mock.calls[0][1]).toEqual(["cloud","exec","--env","env_a","--branch","laterdog/input/fixture","--attempts","1","Implement $(no-shell) `literal` text"]);
    expect(run.mock.calls[0][2]?.env?.CODEX_HOME).toBe("/private/account-a"); expect(run.mock.calls[0][2]?.env?.OPENAI_API_KEY).toBeUndefined();
  });
  it.each([
    ["[READY] Perform QC on staging environment\ntask-com-ai  •  Oct  3 22:48\nno diff","ready"],
    ["[APPLIED] Change","ready"],["[PENDING] Change","running"],["[RUNNING] Change","running"],["[FAILED] Change","failed"],["[ERROR] Change","failed"],
  ])("parses actual CLI status format: %s",async (status,expected) => {
    const run: CommandRunner = async () => ({ stdout: status,stderr: "",exitCode: 0,timedOut: false });
    expect(await new CodexCloudAdapter({ id: "default",label: "Fixture" },run).inspect("task_fixture")).toBe(expected);
  });
  it.each([
    ["[PENDING] Review PR #82 and add regression test\ntask-com-ai  •  1m ago\nno diff","running"],
    ["[ERROR] Change\ntask-com-ai  •  4m ago","failed"],
  ])("reads the status the CLI prints even when it exits 1, as 0.154.0 does for unfinished tasks: %s",async (status,expected) => {
    const run: CommandRunner = async () => ({ stdout: status,stderr: "",exitCode: 1,timedOut: false });
    expect(await new CodexCloudAdapter({ id: "default",label: "Fixture" },run).inspect("task_fixture")).toBe(expected);
  });
  it("still fails a status read that printed no status, with the CLI's own words",async () => {
    const run: CommandRunner = async () => ({ stdout: "",stderr: "Error: Not signed in",exitCode: 1,timedOut: false });
    await expect(new CodexCloudAdapter({ id: "default",label: "Fixture" },run).inspect("task_fixture")).rejects.toThrow(/Cloud status read failed \(exit 1\): Error: Not signed in/);
    const hung: CommandRunner = async () => ({ stdout: "[PENDING] Change",stderr: "",exitCode: 124,timedOut: true });
    await expect(new CodexCloudAdapter({ id: "default",label: "Fixture" },hung).inspect("task_fixture")).rejects.toThrow(/timed out/);
  });
  it("keeps the trailing newline git apply requires when collecting a diff",async () => {
    const patch = "diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const run: CommandRunner = async () => ({ stdout: patch,stderr: "",exitCode: 0,timedOut: false });
    expect(await new CodexCloudAdapter({ id: "default",label: "Fixture" },run).collect("task_fixture")).toBe(patch);
    const trimmed: CommandRunner = async () => ({ stdout: patch.trimEnd(),stderr: "",exitCode: 0,timedOut: false });
    expect(await new CodexCloudAdapter({ id: "default",label: "Fixture" },trimmed).collect("task_fixture")).toBe(patch);
  });
  it("treats a finished task without changes as an empty diff rather than a collection failure",async () => {
    const run: CommandRunner = async () => ({ stdout: "",stderr: "Error: No diff available for task task_fixture; it may still be running.",exitCode: 1,timedOut: false });
    expect(await new CodexCloudAdapter({ id: "default",label: "Fixture" },run).collect("task_fixture")).toBe("");
  });
  it("surfaces the CLI's own error text and runs in a writable working directory",async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "",stderr: "Error: http error: get_task_details failed: 404 Not Found; body={\"detail\":\"Invalid task ID\"}",exitCode: 1,timedOut: false });
    const adapter = new CodexCloudAdapter({ id: "default",label: "Fixture" },run,{ cwd: "/private/laterdog" });
    await expect(adapter.inspect("task_fixture")).rejects.toThrow(/Invalid task ID/);
    expect(run.mock.calls[0][2]?.cwd).toBe("/private/laterdog");
  });
  it("does not guess a provider status or submission outcome",async () => {
    const run: CommandRunner = async () => ({ stdout: "New incompatible CLI output",stderr: "",exitCode: 0,timedOut: false });
    const adapter = new CodexCloudAdapter({ id: "default",label: "Fixture" },run);
    await expect(adapter.inspect("task_fixture")).rejects.toThrow(/Unrecognized/); await expect(adapter.submit("env","main","test")).rejects.toBeInstanceOf(SubmissionUnknown);
  });
  it("starts the device login in the background and reports its prompt without duplicating an active login",async () => {
    const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; killed: boolean; unref: () => void }> = [];
    const spawner = vi.fn((_binary: string,args: string[]) => {
      expect(args).toEqual(["login","--device-auth"]);
      const child = Object.assign(new EventEmitter(),{ stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, killed: false, unref: () => {} });
      children.push(child); setTimeout(() => child.stdout.emit("data","Open https://auth.openai.com/codex/device and enter code ABCD-EFGH\n"),20); return child;
    });
    const adapter = new CodexCloudAdapter({ id: "default",label: "Fixture" },async () => ({ stdout: "",stderr: "",exitCode: 0,timedOut: false }),{ spawner: spawner as never, loginPromptMs: 2000 });
    const first = await adapter.login(); expect(first.started).toBe(true); expect(first.instructions).toContain("ABCD-EFGH");
    const second = await adapter.login(); expect(second.started).toBe(false); expect(second.instructions).toContain("ABCD-EFGH"); expect(spawner).toHaveBeenCalledTimes(1);
    children[0].exitCode = 0; const third = await adapter.login(); expect(third.started).toBe(true); expect(spawner).toHaveBeenCalledTimes(2);
  });
  it("does not advertise commands that the native cloud CLI lacks",() => {
    const adapter = new CodexCloudAdapter({ id: "default",label: "Fixture" }); expect(adapter.capabilities.continuation).toBe(false); expect(adapter.capabilities.cancellation).toBe(false); expect(adapter.capabilities.activity).toBe("polled");
  });
});
