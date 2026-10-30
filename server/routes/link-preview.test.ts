import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { LinkPreviews } from "../laterdog/link-preview.ts";
import { requiredScope } from "../request-auth.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createLinkPreviewRoutes } from "./link-preview.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve() {
  const previews = new LinkPreviews({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchPage: async () => ({ status: 200, contentType: "text/html", body: "<head><title>Example page</title></head>" }),
  });
  const route = createLinkPreviewRoutes(previews);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback" } as RequestAuth, json, readBody })) return;
    json(res, 404, { from: "other routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/link-preview", () => {
  it("answers the page's preview, nothing for an address it won't read, and 400 without one", async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/api/link-preview?url=${encodeURIComponent("https://example.com/a")}`)).json())
      .toEqual({ preview: { url: "https://example.com/a", title: "Example page" } });
    expect(await (await fetch(`${base}/api/link-preview?url=${encodeURIComponent("http://localhost/")}`)).json()).toEqual({ preview: null });
    expect((await fetch(`${base}/api/link-preview`)).status).toBe(400);
    expect((await fetch(`${base}/api/link-preview`, { method: "POST" })).status).toBe(404);
  });

  it("is open to any signed-in device that reads chats", () => {
    expect(requiredScope("GET", "/api/link-preview")).toBe("client");
  });
});
