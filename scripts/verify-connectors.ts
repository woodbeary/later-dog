import type { IncomingMessage, ServerResponse } from "node:http";

import { MCP_CONNECTORS } from "../src/lib/mcp-connector-catalog.ts";
import { launchVerificationServer } from "./control-laterdog.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";
import { startFakeOAuth } from "../server/testing/fake-oauth-server.ts";

const endpoints = MCP_CONNECTORS.map(({ url, transport, open }) => ({ url, transport, open: open === true }));
if (endpoints.length === 0 || new Set(endpoints.map(({ url }) => url)).size !== endpoints.length) {
  throw new Error("could not read one endpoint per connector from src/lib/mcp-connector-catalog.ts");
}

const fixture = await launchVerificationServer();
const oauth = await startFakeOAuth();
const fakes: FakeHttpMcp[] = [];
let ui: MountedPreview | undefined;
try {
  const tools = [{ name: "list_items", inputSchema: { type: "object", properties: {} } }];
  const official = new Map<string, FakeHttpMcp>();
  for (const { url, transport, open } of endpoints) {
    official.set(url, url === "https://mcp.sentry.dev/mcp"
      ? await startFakeHttpMcp({ requireHeader: { name: "Authorization", value: "Bearer fixture-not-a-secret" }, tools })
      : open
        ? await startFakeHttpMcp({ transport, tools })
        : await startFakeHttpMcp({ transport, acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools }));
  }
  fakes.push(...official.values());
  const toFake = new Map([...official].map(([url, fake]) => [url, fake.url]));
  const toOfficial = new Map([...official].map(([url, fake]) => [fake.url, url]));

  const api = fixtureApi(fixture.info.url);
  await api("POST", "/api/mcp/servers", { name: "notion", type: "http", url: toFake.get("https://mcp.notion.com/mcp") });
  const lapsed = await api("POST", "/api/mcp/servers/notion/test");
  if (lapsed.auth !== "required") throw new Error(`the Notion stand-in should ask for a sign-in: ${JSON.stringify(lapsed)}`);
  await api("POST", "/api/mcp/servers", {
    name: "errors", type: "http", url: toFake.get("https://mcp.sentry.dev/mcp"), headers: { Authorization: "Bearer fixture-not-a-secret" },
  });
  await api("PATCH", "/api/mcp/servers/errors", { enabled: true });

  const authorizations = new Map<string, string>();
  const relay = async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url!;
    if (path.split("?")[0] === "/api/mcp/servers/import") {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "This fixture does not import servers." }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (raw) {
      const body = JSON.parse(raw);
      if (typeof body.url === "string") {
        if (!toFake.has(body.url)) {
          res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: `This fixture has no stand-in for ${body.url}.` }));
          return;
        }
        body.url = toFake.get(body.url);
      }
      raw = JSON.stringify(body);
    }
    const response = await fetch(`${fixture.info.url}${path}`, {
      method: req.method, headers: { "content-type": "application/json" }, ...(raw ? { body: raw } : {}),
    });
    const body = await response.json();
    for (const server of body.servers ?? []) if (toOfficial.has(server.url)) server.url = toOfficial.get(server.url);
    const signIn = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/sign-in$/.exec(path.split("?")[0]!);
    if (req.method === "POST" && signIn && response.ok && typeof body.auth?.authorizationUrl === "string") {
      authorizations.set(signIn[1]!, body.auth.authorizationUrl);
      body.auth.authorizationUrl = "https://oauth.example.test/authorize";
    }
    res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const text = (res: ServerResponse, status: number, message: string) =>
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
  const approve = async (req: IncomingMessage) => {
    const name = new URL(req.url!, "http://fixture").searchParams.get("server") ?? "";
    const authorize = authorizations.get(name);
    if (!authorize) return null;
    const answer = await fetch(authorize, { redirect: "manual" });
    return answer.headers.get("location");
  };

  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/connectors-preview.tsx", route: "/__connectors.html", title: "Isolated connectors fixture",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          configured: false, mode: "self-hosted", setup: "needs-setup", source: "curated",
          cards: ["gmail", "slack", "notion"].map((slug) => ({ slug, label: slug === "gmail" ? "Gmail" : slug[0]!.toUpperCase() + slug.slice(1), blurb: "Connect your account", logo: null, domain: null })),
        }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
      { path: /^\/api\/mcp\/servers(?:\/.*)?$/, handler: relay },
      { path: "/__fixture/consent", handler: async (req, res) => {
        const callback = await approve(req);
        if (!callback) return text(res, 404, "No sign-in is waiting for that server.");
        const done = await fetch(callback);
        text(res, done.status, await done.text());
      } },
      { path: "/__fixture/redirect", handler: async (req, res) => {
        const callback = await approve(req);
        text(res, callback ? 200 : 404, callback ?? "No sign-in is waiting for that server.");
      } },
      { path: "/__fixture/deny", handler: (req, res) => {
        oauth.options.deny = new URL(req.url!, "http://fixture").searchParams.get("on") === "1";
        text(res, 200, `deny=${oauth.options.deny}`);
      } },
    ],
  });
  const origin = new URL(ui.previewUrl).origin;
  console.log(JSON.stringify({
    ...fixture.info,
    previewUrl: ui.previewUrl,
    standIns: endpoints.length,
    consent: `${origin}/__fixture/consent?server=linear`,
    redirect: `${origin}/__fixture/redirect?server=linear`,
    deny: `${origin}/__fixture/deny?on=1`,
    liveProviderTested: false,
  }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  for (const fake of fakes) await fake.close();
  await oauth.close();
  await fixture.close();
}
