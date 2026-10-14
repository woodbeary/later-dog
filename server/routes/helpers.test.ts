import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { HelperBoard } from "../laterdog/helper-board.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Helper } from "../../shared/helpers.ts";
import { createHelpersRoutes } from "./helpers.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))));
});

async function fixture() {
  const auth: RequestAuth = { kind: "loopback", scopes: ["client"] };
  const board = new HelperBoard(() => 1_000);
  const helper: Helper = { id: "review", kind: "agent", label: "Review", state: "running", background: true, startedAt: 0 };
  board.update("visible", helper);
  board.update("private", { ...helper, label: "Private review" });
  const visibleThreads = vi.fn((viewer: RequestAuth) => (threadId: string) => viewer === auth && threadId === "visible");
  const route = createHelpersRoutes({ board, visibleThreads });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { passed: true });
    }
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, auth, helper, visibleThreads };
}

it("returns only the authenticated viewer's visible helper threads through the route table", async () => {
  const { base, auth, helper, visibleThreads } = await fixture();
  const response = await fetch(`${base}/api/helpers`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ helpers: { visible: [helper] } });
  expect(visibleThreads).toHaveBeenCalledExactlyOnceWith(auth);
});

it("passes unrelated paths and methods without reading helper state", async () => {
  const { base, visibleThreads } = await fixture();
  for (const [method, path] of [["POST", "/api/helpers"], ["GET", "/api/helpers/extra"], ["GET", "/api/bots"]]) {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ passed: true });
  }
  expect(visibleThreads).not.toHaveBeenCalled();
});
