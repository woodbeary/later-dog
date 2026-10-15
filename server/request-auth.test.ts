import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionCookie,
  clientBotPatchViolation,
  clientGroupPatchViolation,
  fromLocalTools,
  ipcPeer,
  isAllowedOrigin,
  isLoopbackHost,
  isProxied,
  isSameOrigin,
  provesSameOrigin,
  parseCookies,
  requestOrigin,
  requestSource,
  requiredScope,
  resolveLoopbackTrust,
  resolveRequestAuth,
  sanitizeSource,
  serializeSessionCookie,
  sessionCookieName,
} from "./request-auth.ts";
import { SESSION_TTL_MS, SessionRegistry } from "./sessions.ts";
import { LOCAL_TOOLS_REFUSAL, typedMessageAuthority } from "./laterdog/local-tools-scope.ts";

function request(headers: Record<string, string>, method = "GET"): IncomingMessage {
  return { headers, method } as unknown as IncomingMessage;
}

describe("loopback rules (moved from the server entry, behaviour unchanged)", () => {
  it("accepts localhost, 127.x and ::1 with or without a port", () => {
    for (const host of ["localhost", "localhost:8799", "127.0.0.1", "127.9.9.9:80", "[::1]", "[::1]:8799", "LOCALHOST"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["", "example.com", "127.0.0.1:x", "[::1]x", "100.64.0.1:8799", "localhost.evil.com", "[fe80::1]"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
  it("allows absent origins and loopback origins only", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8799")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("ftp://localhost")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});

describe("origin and cookies", () => {
  it("derives the request origin from Host and the proxy's scheme", () => {
    expect(requestOrigin(request({ host: "bots.example.com" }))).toBe("http://bots.example.com");
    expect(requestOrigin(request({ host: "Bots.Example.com", "x-forwarded-proto": "https" }))).toBe("https://bots.example.com");
    expect(requestOrigin(request({ host: "a:8799", "x-forwarded-proto": "https, http" }))).toBe("https://a:8799");
    expect(requestOrigin(request({}))).toBeNull();
  });
  it("treats absent or matching Origin as same-origin, anything else as foreign", () => {
    expect(isSameOrigin(request({ host: "a.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "a.example", origin: "http://a.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "a.example", "x-forwarded-proto": "https", origin: "https://a.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "a.example", origin: "https://evil.example" }))).toBe(false);
  });
  it("parses cookies and names the session cookie per port and environment", () => {
    expect(parseCookies("a=1; laterdog_session_8799_abc=tok; b = 2")).toEqual(new Map([["a", "1"], ["laterdog_session_8799_abc", "tok"], ["b", "2"]]));
    expect(parseCookies(undefined).size).toBe(0);
    expect(sessionCookieName(8799, "3f2a-uuid-like-id")).toBe("laterdog_session_8799_3f2auuidlike");
    expect(serializeSessionCookie("c", "t", { secure: true, maxAgeSeconds: 60 })).toBe("c=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure");
    expect(serializeSessionCookie("c", "t", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
    expect(clearSessionCookie("c")).toContain("Max-Age=0");
  });
});

describe("request source for the lockout", () => {
  const withPeer = (peer: string, headers: Record<string, string>) =>
    ({ headers, method: "POST", socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  it("takes the LAST forwarded hop, only from a proxy on this machine, and sanitises it", () => {
    expect(requestSource(withPeer("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(requestSource(withPeer("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(requestSource(withPeer("127.0.0.1", {}))).toBe("127.0.0.1");
    expect(requestSource(withPeer("100.64.0.7", { "x-forwarded-for": "1.1.1.1" }))).toBe("100.64.0.7");
    expect(requestSource(withPeer("127.0.0.1", { "x-forwarded-for": "evil\n\u0007 <script>" + "x".repeat(200) }))).toMatch(/^[\w.:%[\]-]{1,64}$/);
    expect(sanitizeSource("")).toBe("unknown");
  });
});

describe("scopes", () => {
  it("keeps full backups, credentials and replacement behind admin scope", () => {
    for (const path of ["status", "export", "upload", "preview", "restore", "client-state", "download/123"]) {
      for (const method of ["GET", "POST", "DELETE"]) expect(requiredScope(method, `/api/workspace-backup/${path}`)).toBe("admin");
    }
  });
  it("is default deny: chat, approvals, rooms, attachments, routines and own session are client; everything else admin", () => {
    for (const [method, path] of [
      ["POST", "/api/bots/x/messages"], ["POST", "/api/bots/x/respond"], ["POST", "/api/threads/t/respond"],
      ["POST", "/api/threads/t/undo"], ["POST", "/api/bots/x/compact"], ["POST", "/api/bots/x/tasks/t/title"],
      ["PATCH", "/api/bots/x/cards/m"], ["POST", "/api/groups/g/messages"], ["PATCH", "/api/groups/g"],
      ["PATCH", "/api/bots/x"], ["PATCH", "/api/bots/x/profile"], ["POST", "/api/attachments"],
      ["GET", "/api/attachments/a.png"], ["POST", "/api/routines"], ["POST", "/api/routines/r/run"],
      ["POST", "/api/routine-runs/seen-all"],
      ["GET", "/api/helpers"], ["GET", "/api/bots"], ["GET", "/api/threads/t/messages"], ["GET", "/api/search"], ["GET", "/api/events"],
      ["GET", "/api/config"], ["GET", "/api/webhooks"], ["POST", "/api/tts/speak"], ["POST", "/api/voice/transcribe"],
      ["GET", "/api/auth/session"], ["POST", "/api/auth/stream-ticket"], ["POST", "/api/auth/logout"],
      ["GET", "/api/bots/x/slack-management"],
    ] as const) expect(requiredScope(method, path), `${method} ${path}`).toBe("client");
    for (const [method, path] of [
      ["POST", "/api/cli-test"], ["GET", "/api/cli-candidates"], ["GET", "/api/instances"], ["PATCH", "/api/instances/claude"],
      ["POST", "/api/bots/x/computer/exec"], ["POST", "/api/bots/x/computer/join"], ["POST", "/api/local-computer/run"],
      ["POST", "/api/bots/x/local-computer/join"], ["POST", "/api/bots/x/local-computer/screenshot"],
      ["GET", "/api/computers/boxes"], ["POST", "/api/computers/boxes/bx_23456789/delete"],
      ["POST", "/api/webhooks"], ["POST", "/api/webhooks/w/rotate"], ["POST", "/api/bots/x/skills"], ["PATCH", "/api/bots/x/skills/s"],
      ["PATCH", "/api/bots/x/model"], ["PATCH", "/api/groups/g/setup"], ["POST", "/api/teams/import"], ["GET", "/api/teams/scout"],
      ["GET", "/api/bots/x/memory"], ["PUT", "/api/bots/x/memory"], ["PUT", "/api/section-context"], ["GET", "/api/threads/t/events"],
      ["GET", "/api/mcp/servers"], ["POST", "/api/mcp/servers"], ["POST", "/api/connectors/slack/authorize"],
      ["POST", "/api/bots/x/slack-management"], ["GET", "/api/bots/x/slack-management/extra"],
      ["PUT", "/api/config"], ["POST", "/api/auth/pairing"], ["GET", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/abc"],
      ["POST", "/api/live/session"], ["POST", "/api/live/call/end"], ["GET", "/api/live/call"], ["PATCH", "/api/live/settings"],
      ["POST", "/api/live/device-revoked"],
      ["POST", "/api/auth/pair"],
      ["GET", "/api/voice/transcribe"],
      ["GET", "/api/something-new"],
    ] as const) expect(requiredScope(method, path), `${method} ${path}`).toBe("admin");
  });

  it("limits a client's bot and room edits to display fields, naming the field it refused", () => {
    expect(clientBotPatchViolation({ unread: true })).toBeNull();
    expect(clientBotPatchViolation({ pinned: true, color: "green" })).toBeNull();
    expect(clientBotPatchViolation({ unread: true, autoApprove: true })).toBe("autoApprove");
    expect(clientBotPatchViolation({ cwd: "/" })).toBe("cwd");
    expect(clientBotPatchViolation([])).toBe("body");
    expect(clientGroupPatchViolation({ name: "Ops", unread: false, turnTimeoutMinutes: 30 })).toBeNull();
    expect(clientGroupPatchViolation({ cwd: "/tmp" })).toBe("cwd");
    expect(clientGroupPatchViolation({ memberIds: [] })).toBe("memberIds");
  });
});

describe("resolveRequestAuth", () => {
  let dir: string;
  let sessions: SessionRegistry;
  const cookieName = "laterdog_session_8799_env";
  const resolve = (headers: Record<string, string>, path = "/api/bots", method = "GET") =>
    resolveRequestAuth(request(headers, method), { sessions, cookieName, streamPath: "/api/events", url: new URL(path, "http://x") });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-auth-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pairedToken(scopes: Array<"admin" | "client"> = ["admin", "client"]): string {
    const { code } = sessions.openPairing({ scopes });
    const result = sessions.exchange({ code, label: "test", source: "1.2.3.4" });
    if (!result.ok) throw new Error(result.error);
    return result.token;
  }

  it("keeps the loopback owner path exactly as before", () => {
    expect(resolve({ host: "127.0.0.1:8799" }).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(resolve({ host: "127.0.0.1:8799", origin: "http://localhost:8799" }).auth?.kind).toBe("loopback");
    const foreignHost = resolve({ host: "100.64.0.9:8799" });
    expect(foreignHost.auth).toBeNull();
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.error).toMatch(/loopback host required.*pair this device/);
    const foreignOrigin = resolve({ host: "127.0.0.1:8799", origin: "https://evil.example" });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.error).toBe("forbidden: cross-origin request");
  });

  it("rejects revoked email cookies, bearers and tickets without falling back to loopback ownership", () => {
    let allowed: Array<"admin" | "client"> = ["admin", "client"];
    sessions = new SessionRegistry({ file: join(dir, "sessions.json"), emailScopes: () => allowed });
    const paired = pairedToken();
    const email = sessions.issue({ label: "browser", email: "person@example.test", scopes: ["admin", "client"] });
    const { ticket } = sessions.issueStreamTicket(email.session.id);
    expect(resolve({ host: "localhost", cookie: `${cookieName}=${email.token}` }).auth?.kind).toBe("session");
    allowed = ["client"];
    for (const host of ["bots.example.com", "localhost"]) {
      expect(resolve({ host, cookie: `${cookieName}=${email.token}` })).toMatchObject({ auth: null, status: 401 });
      expect(resolve({ host, authorization: `Bearer ${email.token}` })).toMatchObject({ auth: null, status: 401 });
      expect(resolve({ host }, `/api/events?ticket=${ticket}`)).toMatchObject({ auth: null, status: 401 });
    }
    expect(resolve({ host: "localhost", authorization: `Bearer ${paired}` }).auth?.kind).toBe("session");
    expect(resolve({ host: "localhost" }).auth?.kind).toBe("loopback");
  });

  it("renews a session only for a request that passed the origin and scope checks", () => {
    let clock = 1_700_000_000_000;
    sessions = new SessionRegistry({ file: join(dir, "sessions.json"), now: () => clock });
    const { code } = sessions.openPairing({ scopes: ["client"] });
    const result = sessions.exchange({ code, label: "phone", source: "10.0.0.2" });
    if (!result.ok) throw new Error(result.error);
    const { token, session } = result;
    clock += SESSION_TTL_MS / 2 + 1;
    const csrf = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "https://evil.example" }, "/api/bots", "POST");
    expect(csrf.error).toBe("forbidden: cross-origin request");
    expect(sessions.list()[0]?.expiresAt).toBe(session.expiresAt);
    const overScope = resolve({ authorization: `Bearer ${token}` }, "/api/bots", "POST");
    expect(overScope.status).toBe(403);
    expect(sessions.list()[0]?.expiresAt).toBe(session.expiresAt);
    const { ticket } = sessions.issueStreamTicket(session.id);
    const stream = resolve({ host: "bots.example.com" }, `/api/events?ticket=${ticket}`);
    expect(stream.auth?.kind === "session" && stream.auth.via).toBe("ticket");
    expect(sessions.list()[0]?.expiresAt).toBe(session.expiresAt);
    const ok = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "http://bots.example.com" });
    expect(ok.auth?.kind).toBe("session");
    expect(sessions.list()[0]?.expiresAt).toBe(clock + SESSION_TTL_MS);
    clock += SESSION_TTL_MS + 1;
    const expired = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "http://bots.example.com" });
    expect(expired.status).toBe(401);
    expect(sessions.list()).toEqual([]);
  });

  it("requires the packaged desktop capability for public loopback mutations", () => {
    const options = (path: string) => ({
      sessions,
      cookieName,
      streamPath: "/api/events",
      url: new URL(path, "http://x"),
      loopbackMutationToken: "owner-token-123",
    });
    const denied = resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "PATCH"),
      options("/api/bots/bot-1"),
    );
    expect(denied.auth).toBeNull();
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/desktop app or a paired device/);

    const desktop = resolveRequestAuth(
      request({
        host: "127.0.0.1:8799",
        "x-laterdog-desktop-owner": "owner-token-123",
      }, "POST"),
      options("/api/routines"),
    );
    expect(desktop.auth?.kind).toBe("loopback");

    expect(resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "GET"),
      options("/api/bots"),
    ).auth?.kind).toBe("loopback");
    const connectorRefresh = resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "GET"),
      options("/api/bots/bot-1/connector-cards/card-1/status?threadId=thread-1"),
    );
    expect(connectorRefresh.auth).toBeNull();
    expect(connectorRefresh.status).toBe(403);
    const traceRoute = "/api/laterdog/jobs/5f2d8c0e-1111-4222-8333-444455556666/trace";
    const traceWithoutOwner = resolveRequestAuth(request({ host: "127.0.0.1:8799" }, "GET"), options(traceRoute));
    expect(traceWithoutOwner.auth).toBeNull();
    expect(traceWithoutOwner.status).toBe(403);
    expect(resolveRequestAuth(request({ host: "127.0.0.1:8799", "x-laterdog-desktop-owner": "wrong-token-123" }, "GET"), options(traceRoute)).auth).toBeNull();
    expect(resolveRequestAuth(request({ host: "127.0.0.1:8799", "x-laterdog-desktop-owner": "owner-token-123" }, "GET"), options(traceRoute)).auth?.kind).toBe("loopback");
    expect(resolveRequestAuth(request({ host: "127.0.0.1:8799" }, "GET"), options("/api/laterdog/jobs/5f2d8c0e-1111-4222-8333-444455556666/activity")).auth?.kind).toBe("loopback");
    for (const path of ["/api/desktop-viewer/vps/bot-1", "/api/desktop-viewer/local/shared/websockify"]) {
      expect(resolveRequestAuth(request({ host: "127.0.0.1:8799" }, "GET"), options(path)).status).toBe(403);
    }
    expect(resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "POST"),
      options("/api/internal/ask-bot"),
    ).auth?.kind).toBe("loopback");
  });

  it("never grants loopback trust to a request that came through a proxy, whatever Host it carries", () => {
    expect(isProxied(request({ host: "localhost", "x-forwarded-for": "203.0.113.9" }))).toBe(true);
    expect(isProxied(request({ host: "localhost", "x-forwarded-proto": "https" }))).toBe(true);
    expect(isProxied(request({ host: "localhost" }))).toBe(false);
    const viaProxy = resolve({ host: "localhost", "x-forwarded-for": "203.0.113.9" });
    expect(viaProxy.auth).toBeNull();
    expect(viaProxy.status).toBe(403);
    expect(viaProxy.error).toMatch(/came through a proxy.*pair this device/);
    const rewritten = resolve({ host: "127.0.0.1:8799", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" });
    expect(rewritten.auth).toBeNull();
    const token = pairedToken();
    expect(resolve({ host: "localhost", "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${token}` }).auth?.kind).toBe("session");
  });

  it("admits a bearer session from any host and reports how it authenticated", () => {
    const token = pairedToken();
    const r = resolve({ host: "100.64.0.9:8799", authorization: `Bearer ${token}` });
    expect(r.auth?.kind).toBe("session");
    expect(r.auth?.kind === "session" && r.auth.via).toBe("bearer");
  });

  it("admits the cookie only same-origin, so a foreign page cannot ride it", () => {
    const token = pairedToken();
    const ok = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "http://bots.example.com" });
    expect(ok.auth?.kind).toBe("session");
    const csrf = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "https://evil.example" }, "/api/bots", "POST");
    expect(csrf.auth).toBeNull();
    expect(csrf.status).toBe(403);
    expect(csrf.error).toBe("forbidden: cross-origin request");
  });

  it("lets a browser sign-in's session make changes only when the browser says the request is its own page's", () => {
    const { credential } = sessions.openPairing({ browser: true, owner: "ada@example.test" });
    const signedIn = sessions.exchange({ code: credential, label: "Chrome on Mac", source: "1.2.3.4", browser: true });
    if (!signedIn.ok) throw new Error(signedIn.error);
    const cookie = `${cookieName}=${signedIn.token}`;
    const cloud = { host: "laterdog-u-0123456789ab.fly.dev", "x-forwarded-proto": "https", cookie };
    expect(resolve(cloud).auth?.kind).toBe("session");
    expect(resolve({ ...cloud, origin: "https://laterdog-u-0123456789ab.fly.dev" }, "/api/bots", "POST").auth?.kind).toBe("session");
    expect(resolve({ ...cloud, "sec-fetch-site": "same-origin" }, "/api/bots", "DELETE").auth?.kind).toBe("session");
    for (const [headers, method] of [[{}, "POST"], [{}, "PUT"], [{}, "PATCH"], [{}, "DELETE"], [{ "sec-fetch-site": "none" }, "POST"], [{ "sec-fetch-site": "cross-site" }, "POST"],
      [{ "sec-fetch-site": "same-site" }, "POST"], [{ origin: "https://evil.example", "sec-fetch-site": "same-origin" }, "POST"]] as const) {
      const refused = resolve({ ...cloud, ...headers }, "/api/bots", method);
      expect(refused.auth, `${method} ${JSON.stringify(headers)}`).toBeNull();
      expect(refused.status).toBe(403);
    }
    expect(resolve(cloud, "/api/bots", "POST").error).toBe("forbidden: this browser's session makes changes only from its own page");
    const paired = pairedToken();
    expect(resolve({ host: "laterdog-u-0123456789ab.fly.dev", "x-forwarded-proto": "https", cookie: `${cookieName}=${paired}` }, "/api/bots", "POST").auth?.kind).toBe("session");
    expect(provesSameOrigin(request({ host: "a.example", origin: "http://a.example" }))).toBe(true);
    expect(provesSameOrigin(request({ host: "a.example" }))).toBe(false);
    expect(provesSameOrigin(request({ host: "a.example", origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it("accepts a stream ticket on the event stream only, once", () => {
    const token = pairedToken();
    const session = sessions.authenticate(token);
    if (!session) throw new Error("no session");
    const { ticket } = sessions.issueStreamTicket(session.id);
    expect(resolve({ host: "bots.example.com" }, `/api/events?ticket=${ticket}`).auth?.kind).toBe("session");
    expect(resolve({ host: "bots.example.com" }, `/api/events?ticket=${ticket}`).status).toBe(401);
    const { ticket: other } = sessions.issueStreamTicket(session.id);
    expect(resolve({ host: "bots.example.com" }, `/api/bots?ticket=${other}`).auth).toBeNull();
  });

  it("enforces scope: a client-only session cannot manage pairing or write config", () => {
    const token = pairedToken(["client"]);
    const denied = resolve({ host: "bots.example.com", authorization: `Bearer ${token}` }, "/api/auth/pairing", "POST");
    expect(denied.status).toBe(403);
    expect(denied.error).toContain("lacks the admin scope");
    const mcpDenied = resolve(
      { host: "bots.example.com", authorization: `Bearer ${token}` },
      "/api/mcp/servers/github/test",
      "POST",
    );
    expect(mcpDenied.status).toBe(403);
    expect(mcpDenied.error).toContain("lacks the admin scope");
    expect(resolve({ host: "bots.example.com", authorization: `Bearer ${token}` }, "/api/bots").auth?.kind).toBe("session");
  });

  it.each([
    ["GET", "/api/settings/custom-domain"],
    ["POST", "/api/settings/custom-domain"],
    ["DELETE", "/api/settings/custom-domain"],
    ["GET", "/api/instances/codex/auth/status?flowId=private-device-flow"],
    ["POST", "/api/instances/codex/auth/start"],
    ["POST", "/api/instances/codex/auth/cancel"],
    ["POST", "/api/instances/codex/auth/sign-out"],
    ["POST", "/api/instances/claude-work/auth/sign-out"],
    ["GET", "/api/usage?from=2026-09-01&to=2026-09-30"],
    ["GET", "/api/usage.csv?from=2026-09-01&to=2026-09-30"],
    ["POST", "/api/keys/test"],
    ["GET", "/api/fleet"],
    ["POST", "/api/fleet/workspaces"],
    ["DELETE", "/api/fleet/workspaces/acme"],
    ["POST", "/api/fleet/upgrade"],
    ["POST", "/api/instances/antigravity/auth/complete"],
  ])("requires admin for server Settings: %s %s", (method, path) => {
    expect(requiredScope(method, path.split("?")[0]!)).toBe("admin");
    const client = pairedToken(["client"]);
    const admin = pairedToken(["admin"]);
    const headers = { host: "bots.example.com", "x-forwarded-proto": "https", origin: "https://bots.example.com" };
    const clientCredentials: Record<string, string>[] = [{ authorization: `Bearer ${client}` }, { cookie: `${cookieName}=${client}` }];
    for (const credential of clientCredentials) {
      const denied = resolve({ ...headers, ...credential }, path, method);
      expect(denied.auth).toBeNull();
      expect(denied.status).toBe(403);
      expect(denied.error).toContain("lacks the admin scope");
    }
    expect(resolve({ ...headers, authorization: `Bearer ${admin}` }, path, method).auth?.kind).toBe("session");
    expect(resolve(headers, path, method).auth).toBeNull();
  });

  it("explains a dead credential instead of silently falling back, even on loopback", () => {
    const token = pairedToken();
    const session = sessions.authenticate(token);
    if (!session) throw new Error("no session");
    sessions.revoke(session.id);
    const remote = resolve({ host: "bots.example.com", authorization: `Bearer ${token}` });
    expect(remote.status).toBe(401);
    expect(remote.error).toMatch(/expired or was revoked; pair this device again/);
    expect(resolve({ host: "127.0.0.1:8799", cookie: `${cookieName}=${token}` })).toMatchObject({ auth: null, status: 401 });
  });
});

describe("an IPC listener (laterdog serve --tunnel) is remote by construction", () => {
  const overSocket = (headers: Record<string, string>) => ({ headers, method: "GET", socket: {} }) as unknown as IncomingMessage;

  it("counts as proxied whatever the headers say; a bare mock without a socket does not", () => {
    expect(ipcPeer(overSocket({ host: "127.0.0.1:8799" }))).toBe(true);
    expect(isProxied(overSocket({ host: "localhost" }))).toBe(true);
    expect(ipcPeer(request({ host: "127.0.0.1:8799" }))).toBe(false);
    expect(isProxied(request({ host: "127.0.0.1:8799" }))).toBe(false);
  });

  it("attributes pairing attempts to the address the tunnel forwarded", () => {
    expect(requestSource(overSocket({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(requestSource(overSocket({}))).toBe("unknown");
  });

  it("never grants loopback trust over the socket, even with a loopback Host and no forwarded headers; a session works", () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-auth-ipc-"));
    try {
      const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
      const gate = { sessions, cookieName: "laterdog_session_test", streamPath: "/api/events", url: new URL("/api/bots", "http://x") };
      const denied = resolveRequestAuth(overSocket({ host: "127.0.0.1:8799" }), gate);
      expect(denied.auth).toBeNull();
      expect(denied.status).toBe(403);
      expect(denied.error).toMatch(/through a proxy/);
      const { code } = sessions.openPairing({ scopes: ["admin", "client"] });
      const paired = sessions.exchange({ code, label: "phone", source: "203.0.113.9" });
      if (!paired.ok) throw new Error(paired.error);
      const admitted = resolveRequestAuth(overSocket({ host: "c-1.later.dog", authorization: `Bearer ${paired.token}` }), gate);
      expect(admitted.auth?.kind).toBe("session");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loopback trust: owner on one person's machine, service on a shared workspace", () => {
  let dir: string;
  let sessions: SessionRegistry;
  const cookieName = "laterdog_session_8799_env";
  const local = { host: "127.0.0.1:8799" };
  const check = (method: string, path: string, options: { trust?: "owner" | "service"; headers?: Record<string, string>; desktopToken?: string } = {}) =>
    resolveRequestAuth(request({ ...local, ...options.headers }, method), {
      sessions, cookieName, streamPath: "/api/events", url: new URL(path, "http://x"),
      ...(options.trust ? { loopbackTrust: options.trust } : {}),
      ...(options.desktopToken !== undefined ? { loopbackMutationToken: options.desktopToken } : {}),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-auth-trust-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SERVICE_CALLS: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/bots?messages=0"],
    ["GET", "/api/threads/thread-1/messages?limit=0"],
    ["GET", "/api/threads/thread-1/messages?limit=200&before=m-1"],
    ["GET", "/api/attachments/0b3c9f2e-1a2b-4c5d-8e9f-0a1b2c3d4e5f.png"],
    ["POST", "/api/bots/bot-1/tasks"],
    ["POST", "/api/bots/bot-1/messages/guarded"],
    ["GET", "/api/bots/bot-1/requests/job_0123456789abcdef?threadId=thread-1"],
    ["POST", "/api/bots/bot-1/requests/job_0123456789abcdef/interrupt"],
    ["DELETE", "/api/bots/bot-1/queue/queue-1"],
    ["POST", "/api/threads/thread-1/respond"],
    ["GET", "/api/auth/session"],
    ["POST", "/api/internal/ask-bot"],
    ["GET", "/api/internal/agents"],
    ["POST", "/api/internal/hook"],
    ["POST", "/api/testing/internal-capability"],
  ];
  const ADMIN_CALLS: Array<[string, string]> = [
    ["PUT", "/api/config"], ["PATCH", "/api/config"], ["GET", "/api/config"],
    ["POST", "/api/webhooks"], ["GET", "/api/webhooks"],
    ["GET", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/sess-admin"], ["POST", "/api/auth/pairing"],
    ["POST", "/api/bots"], ["PATCH", "/api/bots/bot-1"], ["DELETE", "/api/bots/bot-1"],
    ["POST", "/api/instances"], ["GET", "/api/instances"], ["POST", "/api/mcp-servers"],
    ["POST", "/api/keys/test"], ["GET", "/api/usage"], ["GET", "/api/decisions"], ["GET", "/api/decisions.csv"],
    ["POST", "/api/fleet/workspaces"], ["POST", "/api/settings/custom-domain"], ["POST", "/api/workspace-backup/export"],
    ["POST", "/api/bots/bot-1/messages"], ["POST", "/api/bots/bot-1/respond"], ["POST", "/api/bots/bot-1/always-allow"],
    ["POST", "/api/threads/thread-1/undo"], ["POST", "/api/groups/room-1/messages"], ["POST", "/api/routines"], ["GET", "/api/events"],
  ];

  it("keeps the owner exactly as before when no trust is given or trust is owner", () => {
    for (const trust of [undefined, "owner"] as const) {
      for (const [method, path] of [...SERVICE_CALLS, ...ADMIN_CALLS]) {
        expect(check(method, path, { trust }).auth, `${method} ${path}`).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
      }
    }
  });

  it("lets a service reach only its routes, as a client without admin", () => {
    for (const [method, path] of SERVICE_CALLS) {
      expect(check(method, path, { trust: "service" }).auth, `${method} ${path}`).toEqual({ kind: "loopback", scopes: ["client"], trust: "service" });
    }
    for (const [method, path] of ADMIN_CALLS) {
      const denied = check(method, path, { trust: "service" });
      expect(denied.auth, `${method} ${path}`).toBeNull();
      expect(denied.status).toBe(403);
      expect(denied.error).toMatch(/shared server.*sign in/);
    }
  });

  it("still admits a real session with its own scopes on a service-trust server", () => {
    const admin = sessions.issue({ label: "Laptop", scopes: ["admin", "client"] });
    const member = sessions.issue({ label: "Phone", scopes: ["client"] });
    expect(check("PUT", "/api/config", { trust: "service", headers: { authorization: `Bearer ${admin.token}` } }).auth?.kind).toBe("session");
    expect(check("POST", "/api/bots/bot-1/messages", { trust: "service", headers: { authorization: `Bearer ${member.token}` } }).auth?.kind).toBe("session");
    expect(check("PUT", "/api/config", { trust: "service", headers: { authorization: `Bearer ${member.token}` } }).status).toBe(403);
  });

  it("ignores service trust while the desktop capability is in force", () => {
    expect(check("PUT", "/api/config", { trust: "service", desktopToken: "owner-token", headers: { "x-laterdog-desktop-owner": "owner-token" } }).auth)
      .toEqual({ kind: "loopback", scopes: ["admin", "client"] });
  });

  it("defaults to service on a hosted workspace, owner elsewhere, and lets the operator choose", () => {
    const pick = (env: NodeJS.ProcessEnv, flags: { desktopManaged?: boolean; hostedWorkspace?: boolean } = {}) =>
      resolveLoopbackTrust({ env, desktopManaged: false, hostedWorkspace: false, ...flags });
    expect(pick({})).toEqual({ trust: "owner", reason: "self-hosted default" });
    expect(pick({}, { hostedWorkspace: true })).toEqual({ trust: "service", reason: "hosted workspace" });
    expect(pick({ LATERDOG_LOOPBACK_TRUST: "service" })).toEqual({ trust: "service", reason: "LATERDOG_LOOPBACK_TRUST" });
    expect(pick({ LATERDOG_LOOPBACK_TRUST: " Service " }).trust).toBe("service");
    const forced = pick({ LATERDOG_LOOPBACK_TRUST: "owner" }, { hostedWorkspace: true });
    expect(forced.trust).toBe("owner");
    expect(forced.warning).toMatch(/shared workspace/);
    const typo = pick({ LATERDOG_LOOPBACK_TRUST: "own3r\n" });
    expect(typo.trust).toBe("service");
    expect(typo.warning).toMatch(/not owner or service/);
    expect(typo.warning).not.toContain("\n");
    expect(pick({ LATERDOG_LOOPBACK_TRUST: "" }).trust).toBe("owner");
    const desktop = pick({ LATERDOG_LOOPBACK_TRUST: "service" }, { desktopManaged: true, hostedWorkspace: true });
    expect(desktop.trust).toBe("owner");
    expect(desktop.warning).toMatch(/ignored in the desktop app/);
  });

  it("is always service on a later.dog Cloud home, where a local request is only ever a process on the machine", () => {
    const pick = (env: NodeJS.ProcessEnv) => resolveLoopbackTrust({ env, desktopManaged: false, hostedWorkspace: false, cloudHome: true });
    expect(pick({})).toEqual({ trust: "service", reason: "later.dog Cloud home" });
    expect(pick({ LATERDOG_LOOPBACK_TRUST: "service" })).toEqual({ trust: "service", reason: "later.dog Cloud home" });
    const forced = pick({ LATERDOG_LOOPBACK_TRUST: "owner" });
    expect(forced.trust).toBe("service");
    expect(forced.warning).toMatch(/ignored on a later.dog Cloud home/);
  });

  it("lets only the CLI that started the server, holding its secret, mint a pairing code under service trust", () => {
    const secret = "c".repeat(43);
    const as = (method: string, path: string, header?: string, token: string | null = secret) =>
      resolveRequestAuth(request({ ...local, ...(header ? { "x-laterdog-cli-owner": header } : {}) }, method), {
        sessions, cookieName, streamPath: "/api/events", url: new URL(path, "http://x"), loopbackTrust: "service", cliOwnerToken: token ?? undefined,
      });
    expect(as("POST", "/api/auth/pairing", secret).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(as("GET", "/api/auth/pairing", secret).auth?.kind).toBe("loopback");
    for (const [method, path] of [["PUT", "/api/config"], ["GET", "/api/auth/sessions"], ["DELETE", "/api/auth/pairing"], ["POST", "/api/bots"]] as const) {
      expect(as(method, path, secret).auth, `${method} ${path}`).toBeNull();
    }
    expect(as("POST", "/api/auth/pairing").auth).toBeNull();
    expect(as("POST", "/api/auth/pairing", "d".repeat(43)).auth).toBeNull();
    expect(as("POST", "/api/auth/pairing", "", null).auth).toBeNull();
    expect(as("POST", "/api/auth/pairing", secret, null).auth).toBeNull();
  });
});

describe("local tools token: local tools work on a packaged desktop, but a dog cannot approve itself", () => {
  let dir: string;
  let sessions: SessionRegistry;
  const cookieName = "laterdog_session_8799_env";
  const OWNER = "o".repeat(43);
  const TOOLS = "t".repeat(43);
  const local = { host: "127.0.0.1:8799" };
  const check = (method: string, path: string, headers: Record<string, string> = {}, options: { localToolsToken?: string | null } = {}) =>
    resolveRequestAuth(request({ ...local, ...headers }, method), {
      sessions, cookieName, streamPath: "/api/events", url: new URL(path, "http://x"),
      loopbackMutationToken: OWNER, loopbackTrust: "owner",
      ...(options.localToolsToken === null ? {} : { localToolsToken: options.localToolsToken ?? TOOLS }),
    });
  const tools = { "x-laterdog-local-tools": TOOLS };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-auth-local-tools-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ALLOWED: Array<[string, string]> = [
    ["POST", "/api/bots"], ["PATCH", "/api/bots/bot-1"],
    ["POST", "/api/bots/bot-1/messages"], ["POST", "/api/groups/room-1/messages"], ["POST", "/api/bots/bot-1/messages/m-1/edit"],
    ["POST", "/api/bots/bot-1/interrupt"], ["POST", "/api/groups/room-1/interrupt"],
    ["POST", "/api/bots/bot-1/tasks"], ["POST", "/api/bots/bot-1/tasks/thread-1"], ["PATCH", "/api/bots/bot-1/tasks/thread-1"],
    ["POST", "/api/groups"], ["PATCH", "/api/groups/room-1"], ["POST", "/api/groups/room-1/tasks"], ["PATCH", "/api/groups/room-1/tasks/thread-1"],
  ];
  const REFUSED: Array<[string, string]> = [
    ["POST", "/api/bots/bot-1/respond"], ["POST", "/api/threads/thread-1/respond"], ["PATCH", "/api/bots/bot-1/cards/card-1"],
    ["POST", "/api/bots/bot-1/always-allow"], ["POST", "/api/bots/bot-1/command-allowlist"], ["PUT", "/api/bots/bot-1/command-allowlist/rule-1"],
    ["POST", "/api/bots/bot-1/secret-cards/card-1/provide"], ["POST", "/api/bots/bot-1/connector-cards/card-1/authorize"],
    ["GET", "/api/bots/bot-1/connector-cards/card-1/status"], ["POST", "/api/connectors/github/authorize"],
    ["GET", "/api/desktop-viewer/session"], ["POST", "/api/desktop-viewer/open"], ["GET", "/api/laterdog/jobs/job-1/trace"],
    ["POST", "/api/keys/test"], ["PUT", "/api/config"], ["PATCH", "/api/config"],
    ["POST", "/api/live/session"], ["POST", "/api/laterdog/jobs/job-1/action"], ["POST", "/api/bots/bot-1/computer/exec"],
    ["POST", "/api/computers/boxes/box-1/delete"], ["POST", "/api/team-computers"],
    ["POST", "/api/auth/pairing"], ["DELETE", "/api/auth/pairing/pair-1"], ["PATCH", "/api/instances/claude"], ["POST", "/api/mcp/servers"],
    ["POST", "/api/teams/import"], ["POST", "/api/workspace-backup/restore"], ["DELETE", "/api/bots/bot-1"], ["POST", "/api/routines"],
    ["POST", "/api/handoffs/root-1/continue"], ["POST", "/api/bots/bot-1/messages/guarded"], ["PUT", "/api/bots/bot-1"],
  ];

  it("keeps refusing every change from a local tool that has no token", () => {
    for (const [method, path] of [...ALLOWED, ...REFUSED].filter(([method]) => method !== "GET")) {
      const denied = check(method, path);
      expect(denied.auth, `${method} ${path}`).toBeNull();
      expect(denied.status).toBe(403);
      expect(denied.error).toBe("forbidden: this change must come from the desktop app or a paired device");
    }
  });

  it("lets a local tool with the token do what a paired device can, as a loopback caller marked as local tools", () => {
    for (const [method, path] of ALLOWED) {
      expect(check(method, path, tools).auth, `${method} ${path}`).toEqual({ kind: "loopback", scopes: ["admin", "client"], localTools: true });
    }
  });

  it("refuses, even with the token, everything that would let a dog approve itself", () => {
    for (const [method, path] of REFUSED) {
      const denied = check(method, path, tools);
      expect(denied.auth, `${method} ${path}`).toBeNull();
      expect(denied.status).toBe(403);
      expect(denied.error, `${method} ${path}`).toMatch(/must not be able to approve its own work.*desktop app or a paired device/);
      expect(denied.error).not.toMatch(/\buser\b/i);
    }
  });

  it("refuses a wrong or stale token, and ignores the header when the desktop has not handed one to the server", () => {
    const stale = check("POST", "/api/bots/bot-1/messages", { "x-laterdog-local-tools": "s".repeat(43) });
    expect(stale.auth).toBeNull();
    expect(stale.error).toMatch(/token is out of date; restart the tool/);
    expect(check("POST", "/api/bots/bot-1/messages", { "x-laterdog-local-tools": "" }).error).toMatch(/out of date/);
    const unset = check("POST", "/api/bots/bot-1/messages", tools, { localToolsToken: null });
    expect(unset.auth).toBeNull();
    expect(unset.error).toBe("forbidden: this change must come from the desktop app or a paired device");
  });

  it("never lets the token work through a proxy or from another origin", () => {
    expect(check("POST", "/api/bots/bot-1/messages", { ...tools, "x-forwarded-for": "203.0.113.9" }).auth).toBeNull();
    expect(check("POST", "/api/bots/bot-1/messages", { ...tools, origin: "https://evil.example" }).auth).toBeNull();
    expect(check("POST", "/api/bots/bot-1/messages", { ...tools, host: "c-1.later.dog" }).auth).toBeNull();
  });

  it("leaves the desktop's own header and reads exactly as they were", () => {
    expect(check("POST", "/api/bots/bot-1/respond", { "x-laterdog-desktop-owner": OWNER }).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(check("POST", "/api/bots/bot-1/respond", { "x-laterdog-desktop-owner": OWNER, ...tools }).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(check("GET", "/api/bots", tools).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(check("GET", "/api/bots").auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
  });

  it("still lets a paired device approve, since only the desktop and paired devices may", () => {
    const paired = sessions.issue({ label: "Phone", scopes: ["admin", "client"] });
    expect(check("POST", "/api/bots/bot-1/respond", { authorization: `Bearer ${paired.token}` }).auth?.kind).toBe("session");
  });
});

describe("an apps session (\"Apps on this Mac\" on a Cloud home) is held to the local tools rules, whatever its scopes", () => {
  let dir: string;
  let sessions: SessionRegistry;
  const cookieName = "laterdog_session_8799_env";
  const cloud = { host: "c-1.later.dog", "x-forwarded-proto": "https" };
  const check = (method: string, path: string, headers: Record<string, string>) =>
    resolveRequestAuth(request({ ...cloud, ...headers }, method), { sessions, cookieName, streamPath: "/api/events", url: new URL(path, "https://c-1.later.dog") });
  const signIn = (label: string, localTools?: boolean) => {
    const opened = sessions.openPairing({ scopes: ["admin", "client"], label: "later.dog Cloud" });
    const paired = sessions.exchange({ code: opened.credential, label, source: "203.0.113.4", ...(localTools === undefined ? {} : { localTools }) });
    if (!paired.ok) throw new Error(paired.error);
    return { token: paired.token, bearer: { authorization: `Bearer ${paired.token}` }, id: paired.session.id };
  };
  let apps: ReturnType<typeof signIn>;
  let phone: ReturnType<typeof signIn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-auth-apps-session-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
    apps = signIn("Apps on this Mac", true);
    phone = signIn("iPhone");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ALLOWED: Array<[string, string]> = [
    ["GET", "/api/bots"], ["GET", "/api/threads/thread-1/messages"], ["GET", "/api/events"], ["GET", "/api/auth/session"],
    ["POST", "/api/bots/bot-1/messages"], ["POST", "/api/groups/room-1/messages"], ["POST", "/api/bots/bot-1/messages/m-1/edit"],
    ["POST", "/api/bots/bot-1/interrupt"], ["POST", "/api/groups/room-1/interrupt"],
    ["POST", "/api/bots"], ["PATCH", "/api/bots/bot-1"], ["POST", "/api/groups"], ["PATCH", "/api/groups/room-1"],
    ["POST", "/api/bots/bot-1/tasks"], ["POST", "/api/bots/bot-1/tasks/thread-1"], ["PATCH", "/api/bots/bot-1/tasks/thread-1"],
    ["POST", "/api/groups/room-1/tasks"], ["PATCH", "/api/groups/room-1/tasks/thread-1"],
    ["POST", "/api/auth/logout"],
  ];
  const REFUSED: Array<[string, string]> = [
    ["POST", "/api/bots/bot-1/respond"], ["POST", "/api/threads/thread-1/respond"], ["PATCH", "/api/bots/bot-1/cards/card-1"],
    ["POST", "/api/bots/bot-1/always-allow"], ["POST", "/api/bots/bot-1/command-allowlist"],
    ["POST", "/api/bots/bot-1/secret-cards/card-1/resume"], ["POST", "/api/bots/bot-1/connector-cards/card-1/resume"],
    ["GET", "/api/bots/bot-1/connector-cards/card-1/status"], ["POST", "/api/handoffs/root-1/continue"],
    ["POST", "/api/bots/bot-1/messages/guarded"], ["GET", "/api/desktop-viewer/session"],
    ["PUT", "/api/config"], ["PATCH", "/api/config"], ["POST", "/api/keys/test"], ["PATCH", "/api/instances/claude"],
    ["POST", "/api/auth/pairing"], ["DELETE", "/api/auth/pairing/pair-1"], ["DELETE", "/api/auth/sessions/session-1"],
    ["POST", "/api/auth/stream-ticket"], ["POST", "/api/routines"], ["DELETE", "/api/bots/bot-1"], ["POST", "/api/workspace-backup/restore"],
  ];

  it("lists dogs, reads and sends messages, and makes and changes dogs, rooms and threads, marked as local tools", () => {
    for (const [method, path] of ALLOWED) {
      const { auth } = check(method, path, apps.bearer);
      expect(auth, `${method} ${path}`).toMatchObject({ kind: "session", via: "bearer", scopes: ["admin", "client"], localTools: true });
      expect(fromLocalTools(auth!), `${method} ${path}`).toBe(true);
    }
  });

  it("is refused every approval, answer, setting and pairing route with the local tools refusal, even though it holds admin", () => {
    for (const [method, path] of REFUSED) {
      const denied = check(method, path, apps.bearer);
      expect(denied.auth, `${method} ${path}`).toBeNull();
      expect(denied.status, `${method} ${path}`).toBe(403);
      expect(denied.error, `${method} ${path}`).toBe(`forbidden: ${LOCAL_TOOLS_REFUSAL}`);
    }
  });

  it("is held to the same rules over its cookie and its stream ticket", () => {
    const cookie = { cookie: `${cookieName}=${apps.token}` };
    expect(check("POST", "/api/bots/bot-1/respond", cookie).error).toBe(`forbidden: ${LOCAL_TOOLS_REFUSAL}`);
    expect(check("POST", "/api/bots/bot-1/messages", cookie).auth).toMatchObject({ kind: "session", via: "cookie", localTools: true });
    const { ticket } = sessions.issueStreamTicket(apps.id);
    expect(check("GET", `/api/events?ticket=${ticket}`, {}).auth).toMatchObject({ kind: "session", via: "ticket", localTools: true });
  });

  it("types a message that is never the person: it cannot answer a card or end a take-over", () => {
    const { auth } = check("POST", "/api/bots/bot-1/messages", apps.bearer);
    let asked = false;
    const authority = typedMessageAuthority({ fromLocalTools: fromLocalTools(auth!), session: auth!.kind === "session", desktopManaged: false }, () => {
      asked = true;
      return { kind: "session" as const };
    });
    expect(authority).toEqual({ personPresent: false, via: "api" });
    expect(asked).toBe(false);
  });

  it("leaves an ordinary session exactly as it was: every route its scopes allow, and its typed message is the person", () => {
    for (const [method, path] of [...ALLOWED, ...REFUSED]) {
      const { auth } = check(method, path, phone.bearer);
      expect(auth, `${method} ${path}`).toEqual({ kind: "session", session: expect.objectContaining({ id: phone.id }), via: "bearer", scopes: ["admin", "client"] });
      expect(auth, `${method} ${path}`).not.toHaveProperty("localTools");
      expect(fromLocalTools(auth!)).toBe(false);
    }
    const { auth } = check("POST", "/api/bots/bot-1/messages", phone.bearer);
    expect(typedMessageAuthority({ fromLocalTools: fromLocalTools(auth!), session: true, desktopManaged: false }, () => ({ kind: "session" as const })))
      .toEqual({ personPresent: true, answerer: { kind: "session" } });
  });

  it("does not change what marks the loopback local tools caller", () => {
    expect(fromLocalTools({ kind: "loopback", scopes: ["admin", "client"], localTools: true })).toBe(true);
    expect(fromLocalTools({ kind: "loopback", scopes: ["admin", "client"] })).toBe(false);
  });
});
