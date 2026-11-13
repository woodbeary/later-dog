import { describe, expect, it } from "vitest";
import { CodexRpcError, missingNativeCodexThread } from "./codex.ts";

describe("a Codex thread the app server no longer has", () => {
  it("is recognised by the wording Codex 0.167.2 uses, whatever the error code", () => {
    for (const code of [-32600, -32603, undefined]) {
      expect(missingNativeCodexThread(new CodexRpcError({ code, message: "no rollout found for thread id t-1" }), "t-1")).toBe(true);
    }
    expect(missingNativeCodexThread(new CodexRpcError({ code: -32600, message: "no rollout found for conversation id t-1" }), "t-1")).toBe(true);
    expect(missingNativeCodexThread(new CodexRpcError({ code: -32600, message: "thread not found: t-1" }), "t-1")).toBe(true);
  });

  it("is not confused with another thread or another failure", () => {
    expect(missingNativeCodexThread(new CodexRpcError({ code: -32600, message: "no rollout found for thread id t-2" }), "t-1")).toBe(false);
    expect(missingNativeCodexThread(new CodexRpcError({ code: -32600, message: "thread t-1 is closing; retry thread/resume after the thread is closed" }), "t-1")).toBe(false);
    expect(missingNativeCodexThread(new Error("no rollout found for thread id t-1"), "t-1")).toBe(false);
  });
});
