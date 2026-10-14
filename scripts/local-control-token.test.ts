import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopbackUrl, localControlTokenPath, localToolsHeaders, readLocalControlToken } from "./local-control-token.ts";
import { probeBaseUrls, request } from "./mcp-server.ts";

const TOKEN = "k".repeat(43);

describe("where the desktop writes the local tools token", () => {
  it("is the desktop's own app data folder on each system, with an override for tests and unusual setups", () => {
    expect(localControlTokenPath({}, "darwin", "/Users/me")).toBe("/Users/me/Library/Application Support/later.dog/local-control-token");
    expect(localControlTokenPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me")).toContain("later.dog");
    expect(localControlTokenPath({}, "linux", "/home/me")).toBe("/home/me/.config/later.dog/local-control-token");
    expect(localControlTokenPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/me")).toBe("/x/later.dog/local-control-token");
    expect(localControlTokenPath({ LATERDOG_LOCAL_CONTROL_TOKEN_FILE: " /tmp/t " }, "darwin", "/Users/me")).toBe("/tmp/t");
  });
});

describe("reading the token", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "laterdog-local-token-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a valid token and ignores anything else", () => {
    const file = join(dir, "token");
    writeFileSync(file, `${TOKEN}\n`);
    expect(readLocalControlToken(file)).toBe(TOKEN);
    writeFileSync(file, "short");
    expect(readLocalControlToken(file)).toBeUndefined();
    writeFileSync(file, `${TOKEN}extra`);
    expect(readLocalControlToken(file)).toBeUndefined();
    expect(readLocalControlToken(join(dir, "missing"))).toBeUndefined();
    expect(readLocalControlToken(dir)).toBeUndefined();
  });

  it("offers the token only to loopback addresses, and not when a paired session token is set", () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN);
    const env = { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: file };
    expect(localToolsHeaders("http://127.0.0.1:8799", env)).toEqual({ "X-LaterDog-Local-Tools": TOKEN });
    expect(localToolsHeaders("http://localhost:8799", env)).toEqual({ "X-LaterDog-Local-Tools": TOKEN });
    expect(localToolsHeaders("http://[::1]:8799", env)).toEqual({ "X-LaterDog-Local-Tools": TOKEN });
    expect(localToolsHeaders("https://me.later.dog", env)).toEqual({});
    expect(localToolsHeaders("http://192.168.1.5:8799", env)).toEqual({});
    expect(localToolsHeaders("http://127.0.0.1:8799", { ...env, LATERDOG_SERVER_TOKEN: "laterdog_sess_x" })).toEqual({});
    expect(localToolsHeaders("http://127.0.0.1:8799", { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: join(dir, "missing") })).toEqual({});
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("the MCP server and control script send it automatically", () => {
  let dir: string;
  let seen: Array<{ url: string; headers: IncomingHttpHeaders }>;
  let server: ReturnType<typeof createServer>;
  let base: string;
  const saved = { file: process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE, token: process.env.LATERDOG_SERVER_TOKEN };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-local-token-http-"));
    seen = [];
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/health" ? { app: "laterdog" } : { ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    delete process.env.LATERDOG_SERVER_TOKEN;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [["LATERDOG_LOCAL_CONTROL_TOKEN_FILE", saved.file], ["LATERDOG_SERVER_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("attaches the token to a request once the server is chosen, but never to the probe that finds it", async () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN);
    process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE = file;
    expect(await probeBaseUrls([base])).toBe(base);
    await request("/api/bots/bot-1/messages", { method: "POST", body: "{}" }, base);
    expect(seen[0]!.url).toBe("/api/health");
    expect(seen[0]!.headers["x-laterdog-local-tools"]).toBeUndefined();
    expect(seen[1]!.headers["x-laterdog-local-tools"]).toBe(TOKEN);
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it("sends a paired session token and no local tools token when LATERDOG_SERVER_TOKEN is set, and nothing when no token file exists", async () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN);
    process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE = file;
    process.env.LATERDOG_SERVER_TOKEN = "laterdog_sess_abc";
    await request("/api/bots", {}, base);
    expect(seen[0]!.headers.authorization).toBe("Bearer laterdog_sess_abc");
    expect(seen[0]!.headers["x-laterdog-local-tools"]).toBeUndefined();
    delete process.env.LATERDOG_SERVER_TOKEN;
    process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE = join(dir, "missing");
    await request("/api/bots", {}, base);
    expect(seen[1]!.headers["x-laterdog-local-tools"]).toBeUndefined();
  });
});
