import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstanceConfigMap } from "../contracts.ts";
import { antigravityProfileDirectory } from "../drivers/antigravity-acp.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "../routes/table.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { accountKindOf, MOVABLE_ACCOUNT_ID } from "./ai-account-login.ts";
import { createHomeAccountRoutes } from "./home-accounts.ts";

const OWNER = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "fixture" } } as unknown as RequestAuth;
const ID = "antigravity-0f6c5a52-8d1e-4c3b-9a7e-2b1d0c9e8f7a";
const LOGIN = {
  token: { access_token: "fixture-antigravity-access-1", token_type: "Bearer", refresh_token: "fixture-antigravity-refresh-1", expiry: "2026-11-27T21:00:00Z", expires_in: 3599 },
  auth_method: "oauth-personal",
  id_token_email: "owner@example.test",
};

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function home(signedIn: (dataDir: string) => boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "laterdog-ag-handoff-"));
  dirs.push(dataDir);
  let instances: InstanceConfigMap = { [ID]: { driver: "antigravityAgent", displayName: "Google" } };
  const route = createHomeAccountRoutes({
    cloudHome: true, dataDir, file: join(dataDir, "held.json"),
    instances: () => structuredClone(instances),
    save: async (_id, next) => { instances = structuredClone(next); },
    reload: async () => {},
    busy: () => false,
    exclusive: async (work) => work(),
    signedIn: async () => signedIn(dataDir),
  });
  const put = async (body: unknown) => {
    let answer: { status: number; body: unknown } | undefined;
    const res = { setHeader() {} };
    await route({
      req: { headers: { "content-type": "application/json" } }, res, path: `/api/laterdog/accounts/${ID}`, method: "PUT", auth: OWNER,
      readBody: async () => body,
      json: (_res: unknown, status: number, payload: unknown) => { answer = { status, body: payload }; },
    } as unknown as RouteContext);
    return answer!;
  };
  return { dataDir, put, instances: () => instances };
}

const tokenPath = (dataDir: string) => join(antigravityProfileDirectory(ID, dataDir), "antigravity-acp", "acp_token.json");

describe("handing an Antigravity sign-in to the home", () => {
  it("accepts Antigravity accounts by id", () => {
    expect(MOVABLE_ACCOUNT_ID.test("antigravity")).toBe(true);
    expect(MOVABLE_ACCOUNT_ID.test(ID)).toBe(true);
    expect(accountKindOf(ID)).toBe("antigravity");
    expect(accountKindOf("codex")).toBe("codex");
  });

  it("writes the sign-in into the account's own Antigravity profile, private to the home", async () => {
    const { dataDir, put } = home((dir) => existsSync(tokenPath(dir)));
    const answer = await put({ kind: "antigravity", displayName: "Google", deviceId: "a".repeat(32), login: LOGIN, email: "owner@example.test" });
    expect(answer).toEqual({ status: 200, body: { instanceId: ID, signedIn: true } });
    expect(JSON.parse(readFileSync(tokenPath(dataDir), "utf8")).token.refresh_token).toBe("fixture-antigravity-refresh-1");
    expect(statSync(tokenPath(dataDir)).mode & 0o777).toBe(0o600);
    const marker = readFileSync(join(dataDir, "providers", ID, "handoff.json"), "utf8");
    expect(marker).not.toContain("fixture-antigravity");
  });

  it("takes the sign-in back off the home when the engine can't use it", async () => {
    const { dataDir, put } = home(() => false);
    const answer = await put({ kind: "antigravity", displayName: "Google", deviceId: "a".repeat(32), login: LOGIN });
    expect(answer.status).toBe(422);
    expect(existsSync(tokenPath(dataDir))).toBe(false);
  });

  it("refuses a sign-in of another kind for an Antigravity account", async () => {
    const { put } = home(() => true);
    expect((await put({ kind: "codex", displayName: "Google", deviceId: "a".repeat(32), login: { tokens: { id_token: "x", access_token: "y", refresh_token: "z" } } })).status).toBe(400);
  });
});
