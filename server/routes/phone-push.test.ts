import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { createPhonePush, EXPO_RECEIPTS_URL } from "../laterdog/phone-push.ts";
import { createPhonePushRoutes } from "./phone-push.ts";

it("registers the native app and sends its test ping through HTTP and Expo receipts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "laterdog-push-route-"));
  const sent: unknown[] = [];
  const push = createPhonePush({
    dataDir,
    later: (run) => run(),
    fetcher: (async (url: string, init: RequestInit) => {
      if (url === EXPO_RECEIPTS_URL) return Response.json({ data: { receipt: { status: "ok" } } });
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ data: [{ status: "ok", id: "receipt" }] });
    }) as typeof fetch,
  });
  const old = "ExponentPushToken[olderfixturephone]";
  const native = "ExponentPushToken[nativefixturephone]";
  push.register(old);
  const route = createPhonePushRoutes({ push });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    void route({ req, res, url, path: url.pathname, method: req.method!, auth: { kind: "loopback", scopes: ["client"] }, json, readBody });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const base = `http://127.0.0.1:${address.port}/api/phone/push`;
  try {
    const registered = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: native, app: "later.dog" }) });
    expect(await registered.json()).toEqual({ ok: true, registered: true, app: "later.dog" });
    expect(JSON.parse(readFileSync(join(dataDir, "phone-push.json"), "utf8"))).toEqual({ tokens: [native], native: [native] });
    expect(await (await fetch(`${base}?token=${encodeURIComponent(native)}`)).json()).toEqual({ registered: true, app: "later.dog" });
    expect((await fetch(`${base}/test`)).status).toBe(405);
    expect(await (await fetch(`${base}/test`, { method: "POST" })).json()).toEqual({ ok: true, phones: 1, accepted: 1, errors: [] });
    expect(sent).toEqual([[{ to: native, title: "Test ping", body: "Pings from your dogs reach this phone.", sound: "default", data: { kind: "test" } }]]);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});
