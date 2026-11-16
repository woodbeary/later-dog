import { expect, it } from "vitest";
import { STATIC_CLAUDE_MODELS } from "../drivers/claude.ts";
import { createdDogModel, type DogCreator } from "./created-dog-model.ts";

const creator = (model: string, fields: Partial<DogCreator> = {}): DogCreator => ({
  selection: { instanceId: "anthony", model, effort: "high" }, driverKind: "claudeAgent", helperModel: undefined,
  offered: STATIC_CLAUDE_MODELS.options, ...fields,
});

it("gives a dog another dog makes the helper tier one below its maker, on the maker's account", () => {
  expect(createdDogModel(creator("claude-fable-5-2"))).toEqual({ instanceId: "anthony", model: "claude-opus-5-5" });
  expect(createdDogModel(creator("claude-opus-5-5[1m]"))).toEqual({ instanceId: "anthony", model: "claude-sonnet-5-5" });
  expect(createdDogModel(creator("claude-sonnet-5-5"))).toEqual({ instanceId: "anthony", model: "claude-sonnet-5-5", effort: "high" });
});

it("follows the maker's own helper setting", () => {
  expect(createdDogModel(creator("claude-opus-5-5", { helperModel: "same" }))).toEqual({ instanceId: "anthony", model: "claude-opus-5-5", effort: "high" });
  expect(createdDogModel(creator("claude-sonnet-5-5", { helperModel: "lighter" }))).toEqual({ instanceId: "anthony", model: "claude-haiku-5-5" });
  expect(createdDogModel(creator("claude-fable-5-2", { helperModel: "claude-sonnet-5" }))).toEqual({ instanceId: "anthony", model: "claude-sonnet-5" });
});

it("leaves the workspace default for another engine, an unknown model or a tier the account does not offer", () => {
  expect(createdDogModel(creator("gpt-5.6-sol", { driverKind: "codex" }))).toBeNull();
  expect(createdDogModel(creator("orcarouter/Qwen3.8-27B"))).toBeNull();
  expect(createdDogModel(creator("claude-opus-5-5", { offered: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5", custom: true }] }))).toBeNull();
});
