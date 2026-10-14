import { createServer, type IncomingHttpHeaders } from "node:http";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopbackUrl, localControlTokenPath, localToolsHeaders, readLocalControlToken, withLocalTools } from "./local-control-token.ts";
import { runControlLaterDog } from "./control-laterdog.ts";
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
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    expect(readLocalControlToken(file)).toBe(TOKEN);
    writeFileSync(file, "short", { mode: 0o600 });
    expect(readLocalControlToken(file)).toBeUndefined();
    writeFileSync(file, `${TOKEN}extra`, { mode: 0o600 });
    expect(readLocalControlToken(file)).toBeUndefined();
    expect(readLocalControlToken(join(dir, "missing"))).toBeUndefined();
    expect(readLocalControlToken(dir)).toBeUndefined();
  });

  it("uses the file only when you own it and nobody else can read it, and never through a symlink", () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN, { mode: 0o600 });
    expect(readLocalControlToken(file)).toBe(TOKEN);
    expect(readLocalControlToken(file, { uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
    for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666, 0o700]) {
      chmodSync(file, mode);
      expect(readLocalControlToken(file), mode.toString(8)).toBe((mode & 0o077) === 0 ? TOKEN : undefined);
    }
    chmodSync(file, 0o600);
    const link = join(dir, "link");
    symlinkSync(file, link);
    expect(readLocalControlToken(link)).toBeUndefined();
    chmodSync(file, 0o644);
    expect(readLocalControlToken(file, { platform: "win32" })).toBe(TOKEN);
    expect(localToolsHeaders("http://127.0.0.1:8799", { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: file })).toEqual({});
  });

  it("offers the token only to loopback addresses, and not when a paired session token is set", () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN, { mode: 0o600 });
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
    writeFileSync(file, TOKEN, { mode: 0o600 });
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
    writeFileSync(file, TOKEN, { mode: 0o600 });
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

describe("control-laterdog sends the token itself", () => {
  let dir: string;
  let seen: Array<{ method?: string; url: string; headers: IncomingHttpHeaders }>;
  let server: ReturnType<typeof createServer>;
  let base: string;
  const saved = { file: process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE, token: process.env.LATERDOG_SERVER_TOKEN };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-control-token-"));
    seen = [];
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/api/bots?")) res.end(JSON.stringify({ bots: [{ id: "b1", name: "Bot", threadId: "t1", tasks: [{ threadId: "t1" }] }], groups: [] }));
      else res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    delete process.env.LATERDOG_SERVER_TOKEN;
    delete process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [["LATERDOG_LOCAL_CONTROL_TOKEN_FILE", saved.file], ["LATERDOG_SERVER_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("puts the token on the reads and the writes of a command, from the file it is told about, and nothing when the file is unsafe", async () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN, { mode: 0o600 });
    const env = { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: file };
    await runControlLaterDog(["send", "--bot", "b1", "--text", "hello", "--url", base], { env });
    const requests = seen.filter((entry) => entry.url !== "/api/health");
    expect(requests.map((entry) => `${entry.method} ${entry.url.split("?")[0]}`)).toEqual(["GET /api/bots", "POST /api/bots/b1/messages"]);
    for (const entry of requests) expect(entry.headers["x-laterdog-local-tools"], entry.url).toBe(TOKEN);

    seen.length = 0;
    chmodSync(file, 0o644);
    await runControlLaterDog(["send", "--bot", "b1", "--text", "hello", "--url", base], { env });
    for (const entry of seen) expect(entry.headers["x-laterdog-local-tools"], entry.url).toBeUndefined();
  });

  it("builds the header the same way for any request to a loopback address, and never for a remote one", () => {
    const file = join(dir, "token");
    writeFileSync(file, TOKEN, { mode: 0o600 });
    const env = { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: file };
    expect(new Headers(withLocalTools({ method: "POST" }, "http://127.0.0.1:8799", env).headers).get("x-laterdog-local-tools")).toBe(TOKEN);
    expect(new Headers(withLocalTools({ headers: { "X-LaterDog-Local-Tools": "mine" } }, "http://127.0.0.1:8799", env).headers).get("x-laterdog-local-tools")).toBe("mine");
    expect(new Headers(withLocalTools({}, "https://me.later.dog", env).headers).get("x-laterdog-local-tools")).toBeNull();
  });
});
