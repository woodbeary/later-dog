import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "laterdog-guest-ag-"));
const ID = "antigravity-5b0c1f9e-2d4a-4e7b-9c3f-8a1d6e2b7c40";
const NOW = Date.parse("2026-11-28T05:00:00Z");

let guestCliCredentials: typeof import("./guest-cli-credentials.ts").guestCliCredentials;

beforeAll(async () => {
  vi.stubEnv("LATERDOG_HOME", home);
  vi.resetModules();
  ({ guestCliCredentials } = await import("./guest-cli-credentials.ts"));
  const { antigravityProfileDirectory } = await import("../drivers/antigravity-acp.ts");
  const dir = join(antigravityProfileDirectory(ID), "antigravity-acp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "acp_token.json"), JSON.stringify({
    token: { access_token: "fixture-access", token_type: "Bearer", refresh_token: "fixture-refresh", expiry: "2026-11-28T05:43:00Z", expires_in: 3599 },
    auth_method: "consumer",
    id_token_email: "owner@example.test",
  }));
});

afterAll(() => { vi.unstubAllEnvs(); });

describe("a handed-over Antigravity sign-in on a dog's computer", () => {
  it("lends the engine's own saved sign-in whole, so the computer's engine renews its access token", async () => {
    const { antigravityProfileDirectory } = await import("../drivers/antigravity-acp.ts");
    const id = "antigravity-0a7e3c11-9b2d-4f60-8c5e-1d2f3a4b5c6d";
    const dir = join(antigravityProfileDirectory(id), "antigravity-acp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "acp_token.json"), JSON.stringify({
      client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-native-refresh",
      token_uri: "https://oauth2.example.test/token", scopes: ["scope-a", "scope-b"], project_id: "fixture-project",
    }));
    const lent = JSON.parse((await guestCliCredentials("antigravityAgent", id, {}, NOW)).files.antigravity!);
    expect(lent).toEqual({
      client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-native-refresh",
      token_uri: "https://oauth2.example.test/token", scopes: ["scope-a", "scope-b"], project_id: "fixture-project",
    });
  });

  it("lends the current access token in the layout the home holds, without the refresh token", async () => {
    const out = await guestCliCredentials("antigravityAgent", ID, {}, NOW);
    const lent = JSON.parse(out.files.antigravity!);
    expect(lent.token.access_token).toBe("fixture-access");
    expect(lent.token.expiry).toBe("2026-11-28T05:43:00Z");
    expect(lent.auth_method).toBe("consumer");
    expect(out.files.antigravity).not.toContain("fixture-refresh");
  });

  it("refuses an expired access token", async () => {
    await expect(guestCliCredentials("antigravityAgent", ID, {}, Date.parse("2026-11-28T06:00:00Z"))).rejects.toThrow("current access token");
  });
});
