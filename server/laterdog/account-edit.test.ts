import { describe, expect, it } from "vitest";
import { chatgptPlanAccount, removableAccount, renamableAccount } from "./account-edit.ts";

const claude = { driver: "claudeAgent" as const };
const chatgpt = { driver: "codex" as const, config: { authMode: "chatgpt-plan" } };
const codexCli = { driver: "codex" as const, config: {} };
const grok = { driver: "grokAgent" as const };

describe("Settings → Accounts edits", () => {
  it("renames Claude and ChatGPT plan accounts, added or default", () => {
    expect(renamableAccount("claude", claude)).toEqual({ ok: true });
    expect(renamableAccount("claude-1111", claude)).toEqual({ ok: true });
    expect(renamableAccount("chatgpt", chatgpt)).toEqual({ ok: true });
    expect(renamableAccount("chatgpt-2222", chatgpt)).toEqual({ ok: true });
    expect(renamableAccount("codex", codexCli).ok).toBe(false);
    expect(renamableAccount("grok", grok).ok).toBe(false);
  });

  it("removes only added accounts, never a default", () => {
    expect(removableAccount("claude-1111", claude)).toEqual({ ok: true });
    expect(removableAccount("chatgpt-2222", chatgpt)).toEqual({ ok: true });
    expect(removableAccount("claude", claude)).toMatchObject({ ok: false, error: expect.stringContaining("default") });
    expect(removableAccount("chatgpt", chatgpt).ok).toBe(false);
    expect(removableAccount("codex", codexCli).ok).toBe(false);
    expect(removableAccount("codex-extra", codexCli).ok).toBe(false);
    expect(removableAccount("grok", grok).ok).toBe(false);
  });

  it("tells a ChatGPT plan login from the Codex CLI login", () => {
    expect(chatgptPlanAccount(chatgpt)).toBe(true);
    expect(chatgptPlanAccount(codexCli)).toBe(false);
    expect(chatgptPlanAccount({ driver: "codex", config: "not-an-object" })).toBe(false);
  });
});
