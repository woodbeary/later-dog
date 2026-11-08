import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createExecutionReceiptsRoute } from "./execution-receipts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { UsageRow } from "../usage-ledger.ts";

it("serves bounded execution metadata to admins without trigger identities", async () => {
  let admin = false;
  const row = { at: new Date().toISOString(), botId: "dog", threadId: "thread", model: "model", execution: { verification: "unverified" }, trigger: { kind: "user", email: "private@example.test" } } as UsageRow;
  const route = createExecutionReceiptsRoute({ rows: () => [row] });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    void route({ req, res, url, path: url.pathname, method: req.method!, json, readBody, auth: { kind: "loopback", scopes: admin ? ["admin"] : ["client"] } as RequestAuth });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/executions`;
  try {
    expect((await fetch(url)).status).toBe(403);
    admin = true;
    expect((await fetch(url + "?limit=201")).status).toBe(400);
    const response = await fetch(url + "?limit=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('"verification":"unverified"');
    expect(text).not.toContain("private@example.test");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
