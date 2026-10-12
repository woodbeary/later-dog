// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HIDDEN_MODELS_KEY, modelShown, setModelShown } from "./model-visibility";

describe("which models show in chats", () => {
  it("shows every model until it is switched off, and remembers the choice", () => {
    expect(modelShown("claude", "claude-opus-5-5")).toBe(true);
    setModelShown("claude", "claude-opus-5-5", false);
    expect(modelShown("claude", "claude-opus-5-5")).toBe(false);
    expect(modelShown("claude", "claude-sonnet-5")).toBe(true);
    expect(JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY)!)).toEqual(["claude\u0000claude-opus-5-5"]);
    setModelShown("claude", "claude-opus-5-5", true);
    expect(modelShown("claude", "claude-opus-5-5")).toBe(true);
    expect(JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY)!)).toEqual([]);
  });
});
