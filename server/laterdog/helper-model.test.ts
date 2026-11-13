import { describe, expect, it } from "vitest";

import { claudeHelperEnvironment, claudeTier, helperModelFor, parseHelperModelChoice } from "./helper-model.ts";

describe("helper model", () => {
  it("keeps the dog's own model for helpers unless someone chose otherwise", () => {
    for (const choice of [undefined, "same"] as const) {
      expect(helperModelFor("claude", "claude-opus-5-5", choice)).toEqual({ kind: "inherit" });
      expect(claudeHelperEnvironment("claude-opus-5-5", choice, { custom: false })).toEqual({});
    }
  });

  it("steps one tier down within the Claude family and never to the smallest tier from the top", () => {
    expect(helperModelFor("claude", "claude-fable-5-2", "lighter")).toEqual({ kind: "model", model: "opus" });
    expect(helperModelFor("claude", "claude-opus-5-5", "lighter")).toEqual({ kind: "model", model: "sonnet" });
    expect(helperModelFor("claude", "claude-opus-5-5[1m]", "lighter")).toEqual({ kind: "model", model: "sonnet" });
    expect(helperModelFor("claude", "claude-sonnet-5", "lighter")).toEqual({ kind: "model", model: "haiku" });
    expect(helperModelFor("claude", "opus", "lighter")).toEqual({ kind: "model", model: "sonnet" });
    expect(helperModelFor("claude", "claude-haiku-4-5", "lighter")).toEqual({ kind: "inherit" });
    expect(helperModelFor("claude", "claude-fable-5", "lighter")).not.toEqual({ kind: "model", model: "haiku" });
  });

  it("passes an explicit Claude model through and ignores ids from another family", () => {
    expect(helperModelFor("claude", "claude-opus-5-5", "claude-sonnet-5-5")).toEqual({ kind: "model", model: "claude-sonnet-5-5" });
    expect(helperModelFor("claude", "claude-opus-5-5", "haiku")).toEqual({ kind: "model", model: "haiku" });
    expect(helperModelFor("claude", "claude-opus-5-5", "gpt-5.6-luna")).toEqual({ kind: "inherit" });
  });

  it("leaves helpers alone for models later.dog cannot place in a tier", () => {
    for (const model of [undefined, null, "", "local-model", "orcarouter/Qwen3.8-27B", "kimi-k2.6"]) {
      expect(helperModelFor("claude", model, "lighter")).toEqual({ kind: "inherit" });
    }
    expect(claudeHelperEnvironment("claude-opus-5-5", "lighter", { custom: true })).toEqual({});
  });

  it("leaves Codex helpers unchanged", () => {
    for (const choice of ["same", "lighter", "gpt-5.6-luna"]) {
      expect(helperModelFor("codex", "gpt-5.6-sol", choice)).toEqual({ kind: "inherit" });
    }
  });

  it("sets the variable the Claude Code command-line tool reads for helpers", () => {
    expect(claudeHelperEnvironment("claude-opus-5-5", "lighter", { custom: false })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" });
  });

  it("validates the stored choice", () => {
    expect(parseHelperModelChoice("same")).toEqual({ ok: true, value: "same" });
    expect(parseHelperModelChoice(" lighter ")).toEqual({ ok: true, value: "lighter" });
    expect(parseHelperModelChoice("claude-sonnet-5-5")).toEqual({ ok: true, value: "claude-sonnet-5-5" });
    for (const bad of [42, null, "", "inherit", "default", "two words", "x".repeat(200), "a\nb"]) {
      expect(parseHelperModelChoice(bad).ok).toBe(false);
    }
  });

  it("recognises tiers from ids and aliases only", () => {
    expect(claudeTier("claude-sonnet-5-5")).toBe("sonnet");
    expect(claudeTier("fable")).toBe("fable");
    expect(claudeTier("claude-mythos-preview")).toBeNull();
    expect(claudeTier("my-opus-proxy")).toBeNull();
  });
});
