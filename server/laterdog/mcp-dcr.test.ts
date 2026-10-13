import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpOAuthManager, type McpSignInStatus } from "../mcp-oauth.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth, type FakeOAuthOptions } from "../testing/fake-oauth-server.ts";
import { registeredClient, registrationAttempts, registrationRequest, secretMethod } from "./mcp-dcr.ts";

let dir: string;
let oauth: FakeOAuth | undefined;
let mcp: FakeHttpMcp | undefined;
let manager: McpOAuthManager | undefined;

async function serve(options: FakeOAuthOptions = {}) {
  oauth = await startFakeOAuth(options);
  mcp = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json") });
  return { oauth, mcp, manager };
}

async function signIn(manager: McpOAuthManager, url: string): Promise<McpSignInStatus | undefined> {
  const started = await manager.start("docs", url);
  await fetch(started.authorizationUrl!, { redirect: "follow" });
  for (let i = 0; i < 100 && manager.status("docs", started.flowId)?.phase === "waiting"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return manager.status("docs", started.flowId);
}

const stored = () => JSON.parse(readFileSync(join(dir, "mcp-oauth.json"), "utf8")).servers.docs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-dcr-"));
});
afterEach(async () => {
  manager?.dispose();
  await mcp?.close();
  await oauth?.close();
  manager = undefined;
  mcp = undefined;
  oauth = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("registering later.dog with a server", () => {
  it("asks to be a public app first and only retries with a secret when the server takes nothing else", () => {
    expect(registrationAttempts(undefined)).toEqual(["none"]);
    expect(registrationAttempts(["none", "client_secret_basic"])).toEqual(["none"]);
    expect(registrationAttempts(["private_key_jwt"])).toEqual(["none"]);
    expect(registrationAttempts(["client_secret_post"])).toEqual(["none", "client_secret_post"]);
    expect(registrationAttempts(["client_secret_post", "client_secret_basic"])).toEqual(["none", "client_secret_basic"]);
    expect(registrationRequest("http://127.0.0.1:1/cb", "client_secret_post")).toMatchObject({
      client_name: "later.dog",
      redirect_uris: ["http://127.0.0.1:1/cb"],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  it("reads the client a server hands back, secret and method included", () => {
    expect(registeredClient({ client_id: "abc" }, undefined)).toEqual({ id: "abc", method: "none" });
    expect(registeredClient({ client_id: "abc", client_secret: "s", token_endpoint_auth_method: "none" }, undefined)).toEqual({ id: "abc", method: "none" });
    expect(registeredClient({ client_id: "abc", client_secret: "s" }, ["client_secret_post"])).toEqual({ id: "abc", secret: "s", method: "client_secret_post" });
    expect(registeredClient({ client_id: "abc", client_secret: "s", token_endpoint_auth_method: "client_secret_post" }, undefined))
      .toEqual({ id: "abc", secret: "s", method: "client_secret_post" });
    expect(registeredClient({ client_id: "abc", client_secret: "s", token_endpoint_auth_method: "client_secret_post" }, ["client_secret_basic"]))
      .toEqual({ id: "abc", secret: "s", method: "client_secret_basic" });
    for (const body of [null, [], "abc", {}, { client_id: "" }, { client_id: 7 }]) expect(registeredClient(body, undefined)).toBeNull();
    expect(secretMethod(undefined)).toBe("client_secret_basic");
    expect(secretMethod(["client_secret_post"])).toBe("client_secret_post");
  });
});

describe("signing in with a dynamically registered secret", () => {
  it("uses the secret a server hands back and keeps it for refresh and sign-out", async () => {
    const { oauth, mcp, manager } = await serve({ registrationSecrets: "client_secret_post", tokenAuthMethods: ["client_secret_post"], expiresIn: 60 });
    expect((await signIn(manager, mcp.url))?.phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(1);
    expect(stored()).toMatchObject({ clientId: "client_1", tokenAuth: "client_secret_post", clientSecret: expect.stringMatching(/^secret_/) });
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.counts.refresh).toBe(1);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
    await manager.signOut("docs", mcp.url);
    expect(oauth.clientAuths).toEqual([
      { method: "post", clientId: "client_1" },
      { method: "post", clientId: "client_1" },
      { method: "post", clientId: "client_1" },
    ]);
  });

  it("registers with a secret when the server turns a public app down", async () => {
    const { oauth, mcp, manager } = await serve({ refusePublicRegistration: true, tokenAuthMethods: ["client_secret_basic", "client_secret_post"] });
    expect((await signIn(manager, mcp.url))?.phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(2);
    expect(oauth.clientAuths).toEqual([{ method: "basic", clientId: "client_2" }]);
    expect(stored()).toMatchObject({ clientId: "client_2", tokenAuth: "client_secret_basic" });
  });

  it("does not retry a server that never said it takes secrets", async () => {
    const { oauth, mcp, manager } = await serve({ refusePublicRegistration: true });
    await expect(manager.start("docs", mcp.url)).rejects.toThrow(/would not register later\.dog/);
    expect(oauth.counts.register).toBe(1);
  });

  it("stores no secret for a public app", async () => {
    const { mcp, manager } = await serve();
    expect((await signIn(manager, mcp.url))?.phase).toBe("succeeded");
    expect(stored().clientSecret).toBeUndefined();
    expect(stored().tokenAuth).toBeUndefined();
  });

  it("asks for and remembers the protected resource the server names when it covers the MCP address", async () => {
    const { oauth, mcp, manager } = await serve({ expiresIn: 60 });
    const origin = new URL(mcp.url).origin;
    oauth.options.resource = origin;
    const started = await manager.start("docs", mcp.url);
    expect(new URL(started.authorizationUrl!).searchParams.get("resource")).toBe(`${origin}/`);
    manager.cancel("docs");
    expect((await signIn(manager, mcp.url))?.phase).toBe("succeeded");
    expect(stored().resource).toBe(`${origin}/`);
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
  });
});
