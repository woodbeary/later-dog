import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { containerIsTheSandbox, withContainerAccess } from "./codex-container-sandbox.ts";

vi.mock("../drivers/codex-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../drivers/codex-release.ts")>(),
  readLatestCodexRelease: async () => "0.156.1",
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const HOME = { LATERDOG_CLOUD_ROLE: "home" };
const workspace = () => ({
  thread: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" },
  turn: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } },
});

describe("Codex permissions inside the Cloud home", () => {
  it("knows the Cloud home container is the sandbox, and nothing else is", () => {
    expect(containerIsTheSandbox(HOME)).toBe(true);
    expect(containerIsTheSandbox({})).toBe(false);
    expect(containerIsTheSandbox({ LATERDOG_CLOUD_ROLE: "desktop" })).toBe(false);
  });

  it("gives the owner's Auto dogs the whole container, network included, and keeps Codex's own review", () => {
    expect(withContainerAccess(workspace(), "auto", {}, HOME)).toEqual({
      thread: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "danger-full-access" },
      turn: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "dangerFullAccess" } },
    });
  });

  it("changes nothing on a Mac, for Ask and Edits, or for a guest's confined turn", () => {
    expect(withContainerAccess(workspace(), "auto", {}, {})).toEqual(workspace());
    expect(withContainerAccess(workspace(), "ask", {}, HOME)).toEqual(workspace());
    expect(withContainerAccess(workspace(), "edits", {}, HOME)).toEqual(workspace());
    expect(withContainerAccess(workspace(), "auto", { guestConfined: true }, HOME)).toEqual(workspace());
  });
});

describe("Codex turns in the Cloud home (fake app-server)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "laterdog-codex-container-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.FAKE_CODEX_DUMP;
    await instance?.dispose();
    instance = undefined;
    removeTempDir(scratch);
  });

  const run = async (approvalMode: "auto" | "ask") => {
    const dump = join(scratch, `${approvalMode}.json`);
    process.env.FAKE_CODEX_DUMP = dump;
    instance = await CodexDriver.create({ instanceId: "codex-home", displayName: "Codex", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: `home-${approvalMode}`, text: "push the branch", approvalMode });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string; params: Record<string, unknown> }>;
    return { thread: calls.find((call) => call.method === "thread/start")!.params, turn: calls.find((call) => call.method === "turn/start")!.params };
  };

  it("starts an Auto dog's Codex thread and turn with full access, so git push and gh reach GitHub", async () => {
    vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
    const { thread, turn } = await run("auto");
    expect(thread).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "danger-full-access" });
    expect(turn).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "dangerFullAccess" } });
  });

  it("keeps Ask in the Codex sandbox in the Cloud home", async () => {
    vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
    const { thread, turn } = await run("ask");
    expect(thread).toMatchObject({ sandbox: "workspace-write", approvalsReviewer: "user" });
    expect(turn).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
  });

  it("keeps Auto in the Codex sandbox on a Mac", async () => {
    const { thread, turn } = await run("auto");
    expect(thread).toMatchObject({ sandbox: "workspace-write", approvalsReviewer: "auto_review" });
    expect(turn).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
  });
});
