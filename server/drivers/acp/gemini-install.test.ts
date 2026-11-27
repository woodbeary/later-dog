import { describe, expect, it } from "vitest";
import { serverInstallFor } from "../../engine-install.ts";
import { GeminiAgentDriver } from "./gemini.ts";

describe("Gemini CLI install", () => {
  it("installs on demand from npm where npm is present", () => {
    expect(serverInstallFor(GeminiAgentDriver.install, true)).toEqual({ package: "@google/gemini-cli" });
  });

  it("offers no server install without npm", () => {
    expect(serverInstallFor(GeminiAgentDriver.install, false)).toBeNull();
  });
});
