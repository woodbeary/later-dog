import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectedRepositories, repositoriesEnvironment, repositoriesForTurn, repositoriesFromEnvironment, supervisorRepositorySlugs } from "./connected-repositories.ts";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("connected repositories", () => {
  it("knows nothing until it has asked, then keeps the answer while it is fresh", async () => {
    let clock = 0;
    const read = vi.fn(async () => ["acme/web"]);
    const repositories = createConnectedRepositories(read, 1_000, () => clock);
    expect(repositories.known()).toEqual([]);
    expect(await repositories.refresh()).toEqual(["acme/web"]);
    clock = 999;
    expect(await repositories.refresh()).toEqual(["acme/web"]);
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_000;
    await repositories.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("treats an unreachable supervisor as no repository instead of failing the turn", async () => {
    const repositories = createConnectedRepositories(async () => { throw new Error("connection refused"); });
    expect(await repositories.refresh()).toEqual([]);
    expect(repositories.known()).toEqual([]);
  });

  it("asks again right after the person connects a repository", async () => {
    const answers = [[], ["acme/web"]];
    const repositories = createConnectedRepositories(async () => answers.shift() ?? [], 60_000);
    expect(await repositories.refresh()).toEqual([]);
    repositories.forget();
    expect(await repositories.refresh()).toEqual(["acme/web"]);
  });

  it("starts a turn on the repositories it already knows and refreshes them behind it", async () => {
    let clock = 0;
    let answer: string[] = ["acme/web"];
    let release: () => void = () => undefined;
    const read = vi.fn(() => answer.length > 1 ? new Promise<string[]>((resolve) => { release = () => resolve(answer); }) : Promise.resolve(answer));
    const repositories = createConnectedRepositories(read, 1_000, () => clock);
    expect(repositories.checked()).toBe(false);
    expect(await repositoriesForTurn(repositories)).toEqual(["acme/web"]);
    expect(repositories.checked()).toBe(true);
    clock = 2_000;
    answer = ["acme/web", "acme/api"];
    expect(await repositoriesForTurn(repositories)).toEqual(["acme/web"]);
    expect(read).toHaveBeenCalledTimes(2);
    release();
    await repositories.refresh();
    expect(repositories.known()).toEqual(["acme/web", "acme/api"]);
  });

  it("waits for a fresh answer once the person changes their repositories", async () => {
    const answers = [["acme/web"], []];
    const repositories = createConnectedRepositories(async () => answers.shift() ?? [], 60_000);
    expect(await repositoriesForTurn(repositories)).toEqual(["acme/web"]);
    repositories.forget();
    expect(await repositoriesForTurn(repositories)).toEqual([]);
  });

  it("shares one question between turns that start together", async () => {
    let answer: (slugs: string[]) => void = () => {};
    const read = vi.fn(() => new Promise<string[]>((resolve) => { answer = resolve; }));
    const repositories = createConnectedRepositories(read);
    const first = repositories.refresh();
    const second = repositories.refresh();
    answer(["acme/api"]);
    expect(await Promise.all([first, second])).toEqual([["acme/api"], ["acme/api"]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads the slugs from the supervisor workspace with the desktop's token", async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/workspace" ? { repositories: [{ slug: "acme/web" }, { slug: "" }, {}, { slug: "acme/api" }] } : {}));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no fixture port");
    vi.stubEnv("LATERDOG_SUPERVISOR_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("LATERDOG_TOKEN", "fixture-admin-token");
    expect(await supervisorRepositorySlugs()).toEqual(["acme/web", "acme/api"]);
    expect(seen).toEqual(["Bearer fixture-admin-token"]);
  });

  it("hands the slugs to a dog's MCP server through one variable", () => {
    expect(repositoriesEnvironment([])).toEqual({});
    const env = repositoriesEnvironment(["acme/web", "acme/api"]);
    expect(repositoriesFromEnvironment(env)).toEqual(["acme/web", "acme/api"]);
    expect(repositoriesFromEnvironment({})).toEqual([]);
  });
});
