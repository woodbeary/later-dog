import { describe, expect, it } from "vitest";
import { createGeminiKeyAccountSchema, newAntigravityAccount, newGeminiKeyAccount } from "./google-accounts.ts";

const KEY = "AIzaTestKeyForFixturesOnly0000000000000";

describe("Google accounts", () => {
  it("adds an Antigravity account beside the existing ones", () => {
    const { instanceId, instances } = newAntigravityAccount({ antigravity: { driver: "antigravityAgent", config: { cli: "/opt/agy" } } }, "Work", () => "a1");
    expect(instanceId).toBe("antigravity-a1");
    expect(instances[instanceId]).toEqual({ driver: "antigravityAgent", displayName: "Work", config: { cli: "/opt/agy" } });
  });

  it("keeps a Gemini key in its own account's environment", () => {
    const { instanceId, instances } = newGeminiKeyAccount({}, "Project one", KEY, () => "k1");
    expect(instanceId).toBe("gemini-k1");
    expect(instances[instanceId]).toEqual({ driver: "geminiAgent", displayName: "Project one", environment: { GEMINI_API_KEY: KEY } });
  });

  it("asks whether a key is free tier or allowed paid use", () => {
    expect(createGeminiKeyAccountSchema.safeParse({ displayName: "P", apiKey: KEY, use: "free" }).success).toBe(true);
    expect(createGeminiKeyAccountSchema.safeParse({ displayName: "P", apiKey: KEY }).success).toBe(false);
    expect(createGeminiKeyAccountSchema.safeParse({ displayName: "P", apiKey: "short", use: "paid" }).success).toBe(false);
    expect(createGeminiKeyAccountSchema.safeParse({ displayName: "P", apiKey: `${KEY}\n`, use: "paid", extra: 1 }).success).toBe(false);
  });
});
