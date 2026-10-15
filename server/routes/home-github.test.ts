import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createHomeGitHubRoutes, HOME_GITHUB_OWNER_ONLY, type HomeGitHubRouteDeps } from "./home-github.ts";
import { dispatchRoutes } from "./table.ts";

const owner: RequestAuth = { kind: "session", session: {} as SessionRecord, via: "bearer", scopes: ["admin", "client"] };
const guest: RequestAuth = { kind: "session", session: {} as SessionRecord, via: "cookie", scopes: ["client"] };
const ownerLocalTools: RequestAuth = { ...owner, localTools: true };
const homeService: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(auth: RequestAuth, overrides: Partial<HomeGitHubRouteDeps> = {}) {
  const github = {
    status: vi.fn(async () => ({ login: "octocat", signIn: { phase: "idle" as const } })),
    connect: vi.fn(async () => ({ login: null, signIn: { phase: "waiting" as const, code: "AB12-CD34", url: "https://github.com/login/device" } })),
    disconnect: vi.fn(async () => ({ login: null, signIn: { phase: "idle" as const } })),
  };
  const deps: HomeGitHubRouteDeps = { cloudHome: true, github, ...overrides };
  const routes = [createHomeGitHubRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "elsewhere" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, github };
}

const post = (base: string, path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("GitHub connect routes on a Cloud home", () => {
  it("shows the owner who GitHub is connected as", async () => {
    const { base } = await serve(owner);
    const response = await fetch(`${base}/api/home/github`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ login: "octocat", signIn: { phase: "idle" } });
  });

  it("starts the device flow for the owner and hands back the code and page", async () => {
    const { base, github } = await serve(owner);
    const response = await post(base, "/api/home/github/connect");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ signIn: { phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" } });
    expect(github.connect).toHaveBeenCalledTimes(1);
  });

  it("disconnects for the owner, and says what went wrong when gh fails", async () => {
    const { base, github } = await serve(owner);
    expect((await post(base, "/api/home/github/disconnect")).status).toBe(200);
    expect(github.disconnect).toHaveBeenCalledTimes(1);
    github.disconnect.mockRejectedValueOnce(new Error("Disconnecting GitHub failed (exit 1): permission denied"));
    const response = await post(base, "/api/home/github/disconnect");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Disconnecting GitHub failed (exit 1): permission denied" });
  });

  it("refuses everyone but the owner: other people, a dog's local tools, and the home's own loopback", async () => {
    for (const auth of [guest, ownerLocalTools, homeService]) {
      const { base, github } = await serve(auth);
      for (const response of [await fetch(`${base}/api/home/github`), await post(base, "/api/home/github/connect"), await post(base, "/api/home/github/disconnect")]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: HOME_GITHUB_OWNER_ONLY });
      }
      expect(github.status).not.toHaveBeenCalled(); expect(github.connect).not.toHaveBeenCalled(); expect(github.disconnect).not.toHaveBeenCalled();
    }
  });

  it("takes only GET for the status and POST for the actions", async () => {
    const { base, github } = await serve(owner);
    expect((await post(base, "/api/home/github")).status).toBe(405);
    expect((await fetch(`${base}/api/home/github/connect`)).status).toBe(405);
    expect((await fetch(`${base}/api/home/github/disconnect`)).status).toBe(405);
    expect(github.connect).not.toHaveBeenCalled(); expect(github.disconnect).not.toHaveBeenCalled();
  });

  it("is not there outside a Cloud home, nor for other paths", async () => {
    const { base, github } = await serve(owner, { cloudHome: false });
    expect(await (await fetch(`${base}/api/home/github`)).json()).toEqual({ from: "elsewhere" });
    expect(await (await post(base, "/api/home/github/connect")).json()).toEqual({ from: "elsewhere" });
    expect(github.status).not.toHaveBeenCalled(); expect(github.connect).not.toHaveBeenCalled();
    const home = await serve(owner);
    expect(await (await fetch(`${home.base}/api/home/githubx`)).json()).toEqual({ from: "elsewhere" });
    expect(await (await fetch(`${home.base}/api/home/github/connect/more`)).json()).toEqual({ from: "elsewhere" });
  });
});
