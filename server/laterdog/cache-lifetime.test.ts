import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeAuthSettings } from "../drivers/claude.ts";
import { claudeCacheLifetime, paysPerTokenForCache } from "./cache-lifetime.ts";

const made: string[] = [];
const account = (settings: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-cache-account-"));
  made.push(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
};
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("hour-long cache", () => {
  it("is forced only for a subscription on a Claude Code that does not pick the lifetime itself", () => {
    expect(claudeCacheLifetime({}, false)).toBe("1h");
    expect(claudeCacheLifetime({}, true)).toBeUndefined();
    expect(claudeCacheLifetime({ ANTHROPIC_API_KEY: "key" }, false)).toBeUndefined();
    expect(claudeCacheLifetime({ ENABLE_PROMPT_CACHING_1H: "0" }, false)).toBeUndefined();
  });

  it("counts a key in the account's own settings, or a key helper, as paying per token", () => {
    const keyed = account({ env: { ANTHROPIC_API_KEY: "sk-ant-fixture" } });
    expect(claudeCacheLifetime(keyed, false, readClaudeAuthSettings(keyed, {}))).toBeUndefined();
    const helper = account({ apiKeyHelper: "echo sk-ant-fixture" });
    expect(claudeCacheLifetime(helper, false, readClaudeAuthSettings(helper, {}))).toBeUndefined();
    const plain = account({ env: {} });
    expect(claudeCacheLifetime(plain, false, readClaudeAuthSettings(plain, {}))).toBe("1h");
  });

  it("reads a provider switch set to 0 as off", () => {
    expect(paysPerTokenForCache({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(false);
    expect(paysPerTokenForCache({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(claudeCacheLifetime({ CLAUDE_CODE_USE_VERTEX: "false" }, false)).toBe("1h");
  });
});
