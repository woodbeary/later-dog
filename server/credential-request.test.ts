import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_TARGETS,
  credentialConfigPatch,
  credentialIsConfigured,
  credentialResumeOutcome,
  isPendingCredentialRequest,
  isCredentialTargetId,
  type CredentialConfig,
  type CredentialTargetId,
} from "../shared/credential-request.ts";

const MAPPINGS: Array<[CredentialTargetId, CredentialConfig]> = [
  ["xaiApiKey", { xai: { key: "secret" } }],
  ["ttsKey", { tts: { key: "secret" } }],
  ["openaiImageApiKey", { imageGen: { key: "secret" } }],
];

describe("credential request allowlist", () => {
  it("accepts only declared own ids", () => {
    expect(isCredentialTargetId("xaiApiKey")).toBe(true);
    expect(isCredentialTargetId("composioApiKey")).toBe(false);
    expect(isCredentialTargetId("__proto__")).toBe(false);
    expect(isCredentialTargetId({ toString: () => "xaiApiKey" })).toBe(false);
  });

  it("maps each id to a fixed config location", () => {
    expect(MAPPINGS.map(([id]) => id).sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
    for (const [id, patch] of MAPPINGS) {
      expect(credentialConfigPatch(id, "secret")).toEqual(patch);
      expect(credentialIsConfigured(patch, id)).toBe(true);
      expect(credentialIsConfigured({}, id)).toBe(false);
    }
  });

  it("checks configured state without exposing values", () => {
    expect(credentialIsConfigured({ tts: { key: "secret" } }, "ttsKey")).toBe(true);
    expect(credentialIsConfigured({ tts: { key: "" } }, "ttsKey")).toBe(false);
    expect(Object.keys(CREDENTIAL_TARGETS).sort()).toEqual(["openaiImageApiKey", "ttsKey", "xaiApiKey"]);
  });

  it("offers no OpenCode or Fish Audio key request", () => {
    expect(isCredentialTargetId("opencodeGoApiKey")).toBe(false);
    expect(isCredentialTargetId("fishAudioKey")).toBe(false);
  });

  it("supersedes open room cards only for the bot that requested them", () => {
    const card = {
      kind: "secret",
      secret: { target: "xaiApiKey" },
      from: { botId: "atlas" },
    };
    expect(isPendingCredentialRequest(card, "xaiApiKey", "atlas", true)).toBe(true);
    expect(isPendingCredentialRequest(card, "xaiApiKey", "pixel", true)).toBe(false);
    expect(isPendingCredentialRequest(card, "xaiApiKey", "pixel", false)).toBe(true);
    expect(isPendingCredentialRequest({ ...card, secret: { ...card.secret, provided: true } }, "xaiApiKey", "atlas", true)).toBe(false);
    expect(isPendingCredentialRequest({ ...card, secret: { ...card.secret, dismissed: true } }, "xaiApiKey", "atlas", true)).toBe(false);
    expect(isPendingCredentialRequest({ ...card, secret: { ...card.secret, superseded: true } }, "xaiApiKey", "atlas", true)).toBe(false);
  });

  it("preserves the original save or decline outcome when retrying", () => {
    expect(credentialResumeOutcome({ provided: true })).toBe("provided");
    expect(credentialResumeOutcome({ dismissed: true })).toBe("dismissed");
    expect(credentialResumeOutcome({})).toBeNull();
    expect(credentialResumeOutcome({ provided: true, dismissed: true })).toBeNull();
  });
});
