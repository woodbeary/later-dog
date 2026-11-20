import { describe, expect, it } from "vitest";
import { claudeModelChange, modelBackNotice, modelChangeNotice, ModelChanges, modelName, sameModelId } from "./model-change.ts";

const FRAME = {
  type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry", scope: "session",
  original_model: "claude-opus-5-5", fallback_model: "claude-opus-4-8", request_id: "req_fixture", api_refusal_category: "fixture",
  api_refusal_explanation: "fixture explanation", retracted_message_uuids: ["a", "b"], content: "fixture notice", session_id: "s", uuid: "u",
};

describe("a model the engine swapped in by itself", () => {
  it("reads the engine's own fallback frame: which model, which one answers now, and that safeguards caused it", () => {
    expect(claudeModelChange(FRAME)).toEqual({ from: "claude-opus-5-5", to: "claude-opus-4-8", cause: "safeguards", scope: "session" });
    expect(claudeModelChange({ ...FRAME, trigger: "capacity" })).toMatchObject({ cause: "unavailable" });
    expect(claudeModelChange({ ...FRAME, fallback_model: "claude-opus-5-5" })).toBeUndefined();
    expect(claudeModelChange({ ...FRAME, original_model: undefined })).toBeUndefined();
    expect(claudeModelChange({ ...FRAME, fallback_model: "not a model; rm -rf" })).toBeUndefined();
  });

  it("names models plainly, from the catalog when it knows them", () => {
    expect(modelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelName("claude-opus-5-5", "Claude Opus 5.5")).toBe("Opus 5.5");
    expect(modelName("gpt-6.1-sol", "GPT-6.1-Sol")).toBe("GPT-6.1-Sol");
    expect(modelName("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(sameModelId("claude-opus-5-5[1m]", "Claude-Opus-5-5")).toBe(true);
  });

  it("says calmly what changed and why, with no way around the safeguard", () => {
    expect(modelChangeNotice({ from: "Opus 5.5", to: "Opus 4.8", cause: "safeguards" }))
      .toBe("Opus 5.5's safeguards stopped a reply in this chat, so Opus 4.8 is answering for the rest of it.");
    expect(modelChangeNotice({ from: "Opus 5.5", to: "Opus 4.8", cause: "unavailable" }))
      .toBe("Opus 4.8 is answering in this chat — Opus 5.5 isn't available for it right now.");
    expect(modelBackNotice("Opus 5.5")).toBe("Opus 5.5 is answering again.");
  });

  it("notes each change once per chat, catches a swap the engine only shows at the start of a session, and says when the chosen model is back", () => {
    const changes = new ModelChanges();
    expect(changes.noted("chat", { from: "claude-opus-5-5", to: "claude-opus-4-8" })).toBe(true);
    expect(changes.noted("chat", { from: "claude-opus-5-5", to: "claude-opus-4-8" })).toBe(false);
    expect(changes.started("chat", "claude-opus-5-5", "claude-opus-4-8")).toBeUndefined();
    expect(changes.started("chat", "claude-opus-5-5", "claude-opus-5-5")).toEqual({ kind: "back", model: "claude-opus-5-5" });
    expect(changes.started("chat", "claude-opus-5-5", "claude-opus-5-5")).toBeUndefined();
    expect(changes.started("other", "claude-opus-5-5", "claude-sonnet-5")).toEqual({ kind: "changed", from: "claude-opus-5-5", to: "claude-sonnet-5" });
    expect(changes.started("other", "claude-opus-5-5", "claude-sonnet-5")).toBeUndefined();
    expect(changes.started("third", "claude-opus-5-5", null)).toBeUndefined();
    expect(changes.started("third", "claude-opus-5-5", "claude-opus-5-5[1m]")).toBeUndefined();
  });
});
