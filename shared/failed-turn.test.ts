import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAILED_TURN_MAX_CHARS, failedTurnCause, failedTurnTool } from "./failed-turn";

describe("a failed turn's row", () => {
  it("reads back exactly what was written", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    expect(failedTurnTool(limit)).toEqual({ name: `error: ${limit}`, ok: false });
    expect(failedTurnCause(failedTurnTool(limit).name)).toBe(limit);
    expect(failedTurnCause("Bash")).toBeNull();
    expect(failedTurnCause("notice: retrying")).toBeNull();
  });

  it("keeps a long cause's next action, whichever path wrote it", () => {
    const cause = `Automatic recovery unavailable: ${"the backup engine cannot run this thread here. ".repeat(5)}Original error: Your Pro plan includes 2 cloud computers at once. Delete one to start another.`;
    expect(cause.length).toBeGreaterThan(320);
    expect(failedTurnCause(failedTurnTool(cause).name)).toBe(cause);
  });

  it("shows the sentence inside a provider's JSON refusal instead of the JSON", () => {
    const refusal = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } });
    expect(failedTurnCause(failedTurnTool(refusal).name)).toBe("The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.");
    expect(failedTurnCause(failedTurnTool(`unexpected status 401 Unauthorized: ${JSON.stringify({ detail: "Your session expired. Sign in again." })}`).name)).toBe("unexpected status 401 Unauthorized: Your session expired. Sign in again.");
    expect(failedTurnCause(failedTurnTool(`HTTP 401: ${JSON.stringify({ error: { message: "Incorrect API key provided" } })}`).name)).toBe("HTTP 401: Incorrect API key provided");
    expect(failedTurnCause(failedTurnTool(JSON.stringify({ error: "Rate limited, try again in a minute." })).name)).toBe("Rate limited, try again in a minute.");
    expect(failedTurnCause(failedTurnTool("Codex exited {unexpectedly}").name)).toBe("Codex exited {unexpectedly}");
    expect(failedTurnCause(failedTurnTool(JSON.stringify({ status: 500 })).name)).toBe(JSON.stringify({ status: 500 }));
  });

  it("bounds only a pathological message, and says it was cut", () => {
    const words = failedTurnCause(failedTurnTool("x".repeat(30_000)).name)!;
    expect(words).toHaveLength(FAILED_TURN_MAX_CHARS);
    expect(words.endsWith("…")).toBe(true);
  });

  it("carries the flags a client acts on, and only when set", () => {
    expect(failedTurnTool("Not logged in", { setup: true, terminal: true, claudeUpdate: true }))
      .toEqual({ name: "error: Not logged in", ok: false, setup: true, terminal: true, claudeUpdate: true });
    expect(Object.keys(failedTurnTool("rate limited", { setup: false }))).toEqual(["name", "ok"]);
  });

  it("keeps which account ran out, which limit and when it resets", () => {
    const tool = failedTurnTool("You've hit your limit", { terminal: true, quota: { kind: "weekly", resetsAt: "2026-10-09T17:00:00.000Z", instanceId: "work" } });
    expect(tool.quota).toEqual({ kind: "weekly", resetsAt: "2026-10-09T17:00:00.000Z", instanceId: "work" });
    expect(JSON.parse(JSON.stringify(tool))).toEqual(tool);
    expect(failedTurnTool("limit", { quota: { kind: "", instanceId: "work", plan: "max" } as never }).quota).toEqual({ instanceId: "work" });
    expect(failedTurnTool("limit", {})).not.toHaveProperty("quota");
  });

  it("is the only way the server writes one", () => {
    const dir = new URL("../server/", import.meta.url);
    const handWritten = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testing"))
      .flatMap((file) => readFileSync(new URL(file, dir), "utf8").split("\n")
        .filter((line) => /["'`]error: /.test(line))
        .map((line) => `${file}: ${line.trim()}`));
    expect(handWritten).toEqual([]);
  });
});
