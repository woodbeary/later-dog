import { describe, expect, it } from "vitest";
import { failedTurnCause, failedTurnTool } from "./failed-turn";
import { plainFailure } from "./plain-failure";

const LIVE = `claude exited null before result: [claude-code:unrecognized_model] {"model":"claude-fable-5-2","query_source":"sdk"}`;

const CASES: ReadonlyArray<readonly [string, string]> = [
  [LIVE, "Scout stopped before it finished."],
  ["claude exited 1 before result", "Scout stopped before it finished."],
  ["claude exited 0 before result: fake-claude: simulated crash before result", "Scout stopped before it finished."],
  ["codex exited null (signal SIGKILL) before turn/completed: thread 'main' panicked", "Scout stopped before it finished."],
  ["codex exited 1 before turn/completed; no stderr after the last app-server output", "Scout stopped before it finished."],
  ["Antigravity ACP exited SIGTERM.", "Scout stopped before it finished."],
  ["Antigravity ACP exited unexpectedly. Reinstall it from Engines.", "Scout stopped before it finished."],
  ["pi turn failed", "Scout stopped before it finished."],
  ["turn failed", "Scout stopped before it finished."],
  ["Claude began a steered message but went silent; the turn was closed.", "Scout went quiet after your new message, so the turn was stopped."],
  ["no activity for 10 minutes — the turn was stopped", "Scout showed no progress for 10 minutes, so the turn was stopped."],
  ["no activity for 1 minutes — the turn was stopped", "Scout showed no progress for 1 minute, so the turn was stopped."],
  ["`claude` isn't installed, or isn't on this app's PATH", "Scout could not start because a program it needs is missing on this computer."],
  ["`codex` isn't executable — check its file permissions", "Scout could not start because a program it needs is not allowed to run on this computer."],
  ["`pi` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file", "Scout could not start because the request was too large. Try a shorter message."],
  ["spawn failed: spawn E2BIG", "Scout could not start. Try again."],
  ["Antigravity initialization timed out after 60 seconds (darwin-arm64). Check the install.", "Scout did not start in time. Try again."],
  ["Claude review timed out", "Scout did not get an answer in time. Try again."],
  ["could not deliver approval to the provider; retry the task after reconnecting.", "Your answer did not reach Scout. Try the task again."],
  ["queued message could not start — it did not say why", "Your waiting message could not start. Send it again."],
  ["queued channel message could not start — the dog was removed", "Your waiting message could not start. Send it again."],
  ["Could not carry on with Work Claude: the account is still resting", "Could not carry on with Work Claude. Try again."],
  ["Could not continue on Personal: Error: no session", "Could not continue on Personal. Try again."],
  ["MCP server could not start; check its command and installation", "A connected tool could not start. Check its settings."],
  ["MCP server exited before the session closed", "A connected tool stopped before the turn ended."],
  ["MCP startup timed out", "A connected tool did not start in time. Try again."],
  ["MCP request timed out; execution outcome may be uncertain", "A connected tool did not answer in time, so it is not clear whether it finished."],
  ["Codex did not shut down after it was asked to stop.", "Scout did not stop when asked, so some of its work may still be running."],
  ["The helpers stopped with this turn.", "Work running in the background stopped when this turn ended."],
  ["The remaining helpers stopped with this turn.", "Work running in the background stopped when this turn ended."],
  ["xAI HTTP 503: upstream connect error", "The service behind Scout's account had a problem. Try again."],
  ["HTTP 502", "The service behind Scout's account had a problem. Try again."],
  ["503 Service Unavailable", "The service behind Scout's account had a problem. Try again."],
];

const UNCHANGED = [
  "Your Pro plan includes 2 cloud computers at once. Delete one to start another.",
  "Codex automatic review timed out: \"rm -rf build\". Action did not run. Retry stays Auto. Select Ask for human approval in approval settings.",
  "Your helpers reached their time limit and are being stopped.",
  "A tool kept running past its time limit, so the turn was stopped",
  "2 helpers stopped when this turn ended.",
  "Scout's model is unavailable",
  "Codex exited {unexpectedly}",
];

describe("what a person reads when a turn fails", () => {
  it.each(CASES)("%s", (raw, line) => {
    const plain = plainFailure(raw, "Scout");
    expect(plain.line).toBe(line);
    expect(plain.detail).toBe(raw);
  });

  it("names the dog when it is known and says your dog when it is not", () => {
    expect(plainFailure("claude exited 1 before result").line).toBe("Your dog stopped before it finished.");
    expect(plainFailure("claude exited 1 before result", "  ").line).toBe("Your dog stopped before it finished.");
  });

  it.each(UNCHANGED)("keeps words that are already plain: %s", (raw) => {
    expect(plainFailure(raw, "Scout")).toEqual({ line: raw });
  });

  it("still reads the sentence out of a provider's JSON body and keeps the body as detail", () => {
    const raw = `HTTP 401: ${JSON.stringify({ error: { message: "Incorrect API key provided" } })}`;
    expect(plainFailure(raw, "Scout")).toEqual({ line: "HTTP 401: Incorrect API key provided", detail: raw });
  });

  it("never carries a token-shaped string in its detail", () => {
    const secrets = ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", "xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "ghp_abcdefghijklmnopqrstuvwxyz0123"];
    for (const secret of secrets) {
      const plain = plainFailure(`claude exited 1 before result: Authorization: Bearer ${secret} rejected; ANTHROPIC_API_KEY=${secret}`, "Scout");
      expect(plain.line).toBe("Scout stopped before it finished.");
      expect(plain.detail).toContain("claude exited 1 before result");
      expect(plain.detail).not.toContain(secret);
      expect(plain.detail).toContain("«redacted");
    }
  });

  it("caps a long detail", () => {
    const plain = plainFailure(`claude exited 1 before result: ${"x".repeat(5_000)}`, "Scout");
    expect(plain.detail!.length).toBeLessThanOrEqual(1_200);
    expect(plain.detail!.endsWith("…")).toBe(true);
  });
});

describe("the failure row on the wire", () => {
  it("puts the plain sentence in name and the raw cause in detail", () => {
    const tool = failedTurnTool(LIVE, { who: "Scout" });
    expect(tool).toEqual({ name: "error: Scout stopped before it finished.", ok: false, detail: LIVE });
    expect(failedTurnCause(tool.name)).toBe("Scout stopped before it finished.");
    expect(JSON.parse(JSON.stringify(tool))).toEqual(tool);
  });

  it("leaves sign-in, limits, places, the update prompt, safety blocks and lines written for the person as they are", () => {
    const raw = "claude exited 1 before result: Not logged in";
    expect(failedTurnTool(raw, { setup: true, who: "Scout" })).toEqual({ name: `error: ${raw}`, ok: false, setup: true });
    expect(failedTurnTool(raw, { claudeUpdate: true, who: "Scout" }).name).toBe(`error: ${raw}`);
    expect(failedTurnTool(raw, { quota: { kind: "weekly" }, who: "Scout" }).name).toBe(`error: ${raw}`);
    expect(failedTurnTool(raw, { written: true, who: "Scout" })).toEqual({ name: `error: ${raw}`, ok: false });
    const safety = "codex exited 1 before turn/completed: safety_check_failed";
    expect(failedTurnTool(safety, { who: "Scout" }).name).toBe(`error: ${safety}`);
    const mac = "CUA Driver is not ready for this computer — check permissions and restart later.dog";
    expect(failedTurnTool(mac).name).toBe(`error: ${mac}`);
  });
});
