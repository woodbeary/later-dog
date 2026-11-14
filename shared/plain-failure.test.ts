import { describe, expect, it } from "vitest";
import { failedTurnCause, failedTurnTool } from "./failed-turn";
import { plainFailure, retryCannotFix } from "./plain-failure";

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
  ["Could not carry on with Personal: spawn failed", "Could not carry on with Personal. Try again."],
  ["Could not continue on Personal: Error: no session", "Could not continue on Personal. Try again."],
  ["MCP server could not start; check its command and installation", "A connected tool could not start. Check its settings."],
  ["MCP server exited before the session closed", "A connected tool stopped before the turn ended."],
  ["MCP startup timed out", "A connected tool did not start in time. Try again."],
  ["MCP request timed out; execution outcome may be uncertain", "A connected tool did not answer in time, so it is not clear whether it finished."],
  ["Codex did not shut down after it was asked to stop.", "Scout did not stop when asked, so some of its work may still be running."],
  ["xAI HTTP 503: upstream connect error", "The service behind Scout's account is busy or briefly unavailable. Try again in a moment."],
  ["HTTP 502", "The service behind Scout's account is busy or briefly unavailable. Try again in a moment."],
  ["503 Service Unavailable", "The service behind Scout's account is busy or briefly unavailable. Try again in a moment."],
  ["API Error: 529 Overloaded. This is a server-side issue, usually temporary.", "The service behind Scout's account is busy or briefly unavailable. Try again in a moment."],
  ["stream disconnected before completion: HTTP 503 Service Unavailable", "The service behind Scout's account is busy or briefly unavailable. Try again in a moment."],
  ["claude exited 5 before result: claude: API error (503): service temporarily unavailable", "Scout stopped because the service behind its account is busy or briefly unavailable. Try again in a moment."],
];

const REASONS: ReadonlyArray<readonly [string, string, boolean]> = [
  ["claude exited 1 before result: Not logged in · Please run /login", "Scout stopped because its account needs you to sign in again.", true],
  ["claude exited 1 before result: Invalid API key · Please run /login", "Scout stopped because its account needs you to sign in again.", true],
  [`claude exited 1 before result: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}`, "Scout stopped because its account needs you to sign in again.", true],
  ["Antigravity ACP exited 1. Sign in with Google first.", "Scout stopped because its account needs you to sign in again.", true],
  ["claude exited 1 before result: Claude AI usage limit reached|1731500000", "Scout stopped because its account is out of usage for now.", false],
  ["codex exited 1 before turn/completed: Error: You've hit your usage limit. Try again at 3:00 PM.", "Scout stopped because its account is out of usage until 3:00 PM.", false],
  ["queued message could not start — Claude is not signed in", "Your waiting message could not start: Scout's account needs you to sign in again.", true],
  ["queued channel message could not start — usage limit reached until 5pm", "Your waiting message could not start: Scout's account is out of usage until 5pm.", false],
  ["queued message could not start — Work is turned off", "Your waiting message could not start: Scout's account is turned off. Turn it back on or pick another account.", false],
  ["Could not carry on with Opus: Claude needs you to sign in again", "Could not carry on with Opus: it needs you to sign in again.", true],
  ["Could not carry on with Work Claude: the account is still resting", "Could not carry on with Work Claude: it is out of usage for now.", false],
  ["Could not continue on Work account: this account is turned off.", "Could not continue on Work account: it is turned off. Turn it back on or pick another account.", false],
  ["Antigravity initialization timed out after 30 seconds (darwin-arm64). The runtime reported insufficient disk space while starting.", "Scout could not start because this computer is almost out of space. Free up some space and try again.", false],
  ["git status timed out after 30 s: no space left on device", "Scout stopped because this computer is almost out of space. Free up some space and try again.", false],
];

const UNCHANGED = [
  "Your Pro plan includes 2 cloud computers at once. Delete one to start another.",
  "Codex automatic review timed out: \"rm -rf build\". Action did not run. Retry stays Auto. Select Ask for human approval in approval settings.",
  "Your helpers reached their time limit and are being stopped.",
  "A tool kept running past its time limit, so the turn was stopped",
  "2 helpers stopped when this turn ended.",
  "Scout's model is unavailable",
  "Codex exited {unexpectedly}",
  "The helpers stopped with this turn.",
  "claude exited 1 before result: please sign in to Claude to continue",
  "Not logged in · Please run /login",
];

describe("what a person reads when a turn fails", () => {
  it.each(CASES)("%s", (raw, line) => {
    const plain = plainFailure(raw, "Scout");
    expect(plain.line).toBe(line);
    expect(plain.detail).toBe(raw);
  });

  it.each(REASONS)("keeps the reason: %s", (raw, line, signIn) => {
    const plain = plainFailure(raw, "Scout");
    expect(plain.line).toBe(line);
    expect(plain.detail).toBe(raw);
    expect(Boolean(plain.setup)).toBe(signIn);
    expect(Boolean(failedTurnTool(raw, { who: "Scout" }).setup)).toBe(signIn);
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

describe("an error that retrying cannot fix never reads as a busy service", () => {
  it.each([
    ['API Error: 529 {"error":{"message":"Your credit balance is too low"}}', "Scout stopped because its account is out of credit. Add credit or pick another account."],
    ["API Error: 500 The model claude-x does not exist", "Scout stopped because its account cannot use the model it is set to. Pick another model."],
    ["There's an issue with the selected model (claude-x). It may not exist or you may not have access to it.", "Scout stopped because its account cannot use the model it is set to. Pick another model."],
    ["Prompt is too long", "Scout stopped because the conversation is too long for its model. Start a new chat or pick a model with more room."],
    ["claude exited 1 before result: API Error: 503 credit balance is too low", "Scout stopped because its account is out of credit. Add credit or pick another account."],
  ])("%s", (raw, line) => {
    expect(retryCannotFix(raw)).toBe(true);
    expect(plainFailure(raw, "Scout")).toEqual({ line, detail: raw });
  });

  it("still says busy for an overloaded service, which the watch retries", () => {
    const raw = "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
    expect(retryCannotFix(raw)).toBe(false);
    expect(plainFailure(raw, "Scout").line).toBe("The service behind Scout's account is busy or briefly unavailable. Try again in a moment.");
  });
});
