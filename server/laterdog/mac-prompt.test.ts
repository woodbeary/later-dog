import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMacPromptGate, MAC_PROMPT_REPEAT_MS, macPromptOf, macPromptWords } from "./mac-prompt.ts";

describe("a macOS permission window waiting on the Mac", () => {
  it("is read from the Mac's answer and named in plain words", () => {
    expect(macPromptOf({ isError: true, macPrompt: { owner: "UserNotificationCenter" } })).toEqual({ owner: "UserNotificationCenter" });
    expect(macPromptOf({ isError: true })).toBeNull();
    expect(macPromptWords("universalAccessAuthWarn")).toBe("Click Allow on your Mac: Accessibility window is waiting for you");
    expect(macPromptWords("Something")).toBe("Click Allow on your Mac: a macOS permission window is waiting for you");
  });

  it("tells the person once per chat every 10 minutes, not on every retry", () => {
    let now = 0;
    const gate = createMacPromptGate(() => now);
    expect(gate("t1")).toBe(true);
    expect(gate("t1")).toBe(false);
    expect(gate("t2")).toBe(true);
    now += MAC_PROMPT_REPEAT_MS;
    expect(gate("t1")).toBe(true);
  });

  it("the home posts a needs-you line and an urgent phone notification for it, and still returns the Mac's answer to the dog", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toContain("return flagMacPrompt(capability, await macWaits.run(capability.threadId, operation, send));");
    expect(index).toContain('notify(buildNotification("takeover", bot, capability.threadId,');
  });
});
