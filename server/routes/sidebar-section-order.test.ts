import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createSidebarSectionOrderRoutes, SIDEBAR_SECTION_ORDER_PATH } from "./sidebar-section-order.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(saved: string[]) {
  const asked: string[][] = [];
  const routes = [createSidebarSectionOrderRoutes({
    order: (sections) => {
      asked.push([...sections]);
      return [...sections.filter((name) => saved.includes(name)), ...saved.filter((name) => !sections.includes(name))];
    },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

describe("PUT /api/sidebar-sections/order", () => {
  it("saves the order on the server and answers with every saved section", async () => {
    const { base, asked } = await serve(["Work", "Home", "Side"]);
    const response = await fetch(`${base}${SIDEBAR_SECTION_ORDER_PATH}`, { method: "PUT", body: JSON.stringify({ sections: ["Side", "Work"] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sections: ["Side", "Work", "Home"] });
    expect(asked).toEqual([["Side", "Work"]]);
  });

  it("refuses a body without names and other methods, and leaves other paths alone", async () => {
    const { base, asked } = await serve(["Work"]);
    expect((await fetch(`${base}${SIDEBAR_SECTION_ORDER_PATH}`, { method: "PUT", body: JSON.stringify({ sections: [""] }) })).status).toBe(400);
    expect((await fetch(`${base}${SIDEBAR_SECTION_ORDER_PATH}`, { method: "PUT", body: JSON.stringify({ order: [] }) })).status).toBe(400);
    expect((await fetch(`${base}${SIDEBAR_SECTION_ORDER_PATH}`)).status).toBe(405);
    expect(await (await fetch(`${base}/api/sidebar-sections`)).json()).toEqual({ from: "inline routes" });
    expect(asked).toEqual([]);
  });

  it("needs the owner's admin scope like the other section changes", () => {
    expect(requiredScope("PUT", SIDEBAR_SECTION_ORDER_PATH)).toBe("admin");
    expect(requiredScope("POST", "/api/sidebar-sections")).toBe("admin");
  });
});
