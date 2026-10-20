import { describe, expect, it } from "vitest";
import { CLAUDE_KEYCHAIN_SERVICE, claudeCredentialsFile, claudeKeychainAccount, claudeKeychainService } from "./claude-keychain.ts";

describe("where the Claude CLI keeps a sign-in on this computer", () => {
  it("uses the Keychain item name that Claude Code 2.1.293 reads", () => {
    expect(claudeKeychainService({})).toBe(CLAUDE_KEYCHAIN_SERVICE);
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "" })).toBe(CLAUDE_KEYCHAIN_SERVICE);
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/Users/jacoblopez/.claude" })).toBe("Claude Code-credentials-d6b39fe8");
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/Users/jacoblopez/.claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" })).toBe(CLAUDE_KEYCHAIN_SERVICE);
    expect(claudeKeychainService({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/jacoblopez/.claude" })).toBe("Claude Code-credentials-d6b39fe8");
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/Users/jacoblopez/.claude/" })).not.toBe("Claude Code-credentials-d6b39fe8");
  });

  it("hashes the NFC form, so a decomposed folder name finds the same item", () => {
    const composed = "/Users/josé/.laterdog/providers/claude-a";
    const decomposed = "/Users/josé/.laterdog/providers/claude-a";
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: decomposed })).toBe(claudeKeychainService({ CLAUDE_CONFIG_DIR: composed }));
  });

  it("uses the login name as the Keychain account and falls back like the CLI", () => {
    expect(claudeKeychainAccount({ USER: "jacoblopez" })).toBe("jacoblopez");
    expect(claudeKeychainAccount({}, () => "fixture.user")).toBe("fixture.user");
    expect(claudeKeychainAccount({ USER: "has space" })).toBe("claude-code-user");
    expect(claudeKeychainAccount({}, () => { throw new Error("no user"); })).toBe("claude-code-user");
  });

  it("finds the plaintext file the CLI falls back to", () => {
    expect(claudeCredentialsFile({}, "/home/fixture")).toBe("/home/fixture/.claude/.credentials.json");
    expect(claudeCredentialsFile({ CLAUDE_CONFIG_DIR: "/data/.laterdog/providers/claude" }, "/data")).toBe("/data/.laterdog/providers/claude/.credentials.json");
    expect(claudeCredentialsFile({ CLAUDE_CONFIG_DIR: "/a", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, "/home/fixture")).toBe("/home/fixture/.claude/.credentials.json");
  });
});
