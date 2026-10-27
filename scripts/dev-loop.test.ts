import { describe, expect, it } from "vitest";
import { chooseHome, lanAddress, plan, stamp } from "./dev-loop.mjs";
import { CloudRefusal, nextWait } from "./dev-connect.mjs";
import { goesToHome, homeHeaders, READY_PATH, readSession, startHomeProxy } from "./dev-home-proxy.mjs";

describe("the dev loop", () => {
  const exists = (file: string) => file.endsWith("my-home.session.json") || file.endsWith("test-pup.session.json");

  it("runs on your own home by default and on a test home when asked", () => {
    expect(chooseHome([], { mySession: "/x/my-home.session.json", testDir: "/t", exists })).toEqual({ kind: "mine", account: null, session: "/x/my-home.session.json" });
    expect(chooseHome(["--home", "test-pup"], { mySession: "/x/my-home.session.json", testDir: "/t", exists })).toEqual({ kind: "test", account: "test-pup", session: "/t/test-pup.session.json" });
    expect(() => chooseHome([], { mySession: "/x/none.json", testDir: "/t", exists })).toThrow(/pnpm dev:connect/);
    expect(() => chooseHome(["--home", "someone"], { exists })).toThrow(/mine or test-/);
  });

  it("pushes server code only to a test home", () => {
    const names = (home: Parameters<typeof plan>[0]["home"]) => plan({ home, lan: "192.168.1.20", phoneRepo: "/nowhere", tunnel: null }).map((service) => service.name);
    expect(names({ kind: "mine", account: null, session: "/x/my-home.session.json" })).toEqual(["desktop", "proxy", "iphone"]);
    expect(names({ kind: "test", account: "test-pup", session: "/t/test-pup.session.json" })).toEqual(["desktop", "proxy", "push", "iphone"]);
  });

  it("finds the address the phone can reach and stamps every line with its source", () => {
    expect(lanAddress({ lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }], en0: [{ family: "IPv4", internal: false, address: "192.168.1.208" }] } as never)).toBe("192.168.1.208");
    expect(stamp("metro", "\u001b[32miOS Bundled\u001b[39m 229ms", new Date(2026, 9, 23, 17, 4, 5))).toBe("17:04:05 metro    | iOS Bundled 229ms");
  });
});

describe("pairing the dev tools with your home", () => {
  it("keeps waiting while the approval is pending, slows down when asked and stops on anything else", () => {
    expect(nextWait(new CloudRefusal(400, "authorization_pending"), 5_000)).toBe(5_000);
    expect(nextWait(new CloudRefusal(400, "slow_down"), 5_000)).toBe(10_000);
    expect(nextWait(new CloudRefusal(400, "access_denied"), 5_000)).toBeNull();
  });
});

describe("the dev home proxy", () => {
  it("forwards only later.dog API paths and speaks as the saved session", () => {
    expect(goesToHome("/api/bots?messages=0")).toBe(true);
    expect(goesToHome("/.well-known/laterdog/environment")).toBe(true);
    expect(goesToHome("/src/main.tsx")).toBe(false);
    const home = { url: new URL("https://h1-hometest.later.dog"), token: "laterdog_sess_abc" };
    expect(homeHeaders({ host: "127.0.0.1:8999", origin: "http://127.0.0.1:5299", cookie: "a=b", accept: "application/json" }, home)).toEqual({
      host: "h1-hometest.later.dog", authorization: "Bearer laterdog_sess_abc", accept: "application/json",
    });
  });

  it("refuses a session file without an https home or a session token", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "dev-session-"));
    writeFileSync(join(dir, "plain.json"), JSON.stringify({ url: "http://example.test", token: "laterdog_sess_x" }));
    writeFileSync(join(dir, "none.json"), JSON.stringify({ url: "https://h1-hometest.later.dog", token: "nope" }));
    expect(() => readSession(join(dir, "plain.json"))).toThrow(/https home/);
    expect(() => readSession(join(dir, "none.json"))).toThrow(/no home session/);
  });

  it("says it is ready without asking a sleeping home, and carries Dev's messages to the home as its session", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createServer } = await import("node:http");
    const seen: { path?: string; authorization?: string; body: string }[] = [];
    const home = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ path: req.url, authorization: req.headers.authorization, body });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, threadId: "t1" }));
      });
    });
    await new Promise<void>((resolve) => home.listen(0, "127.0.0.1", resolve));
    const homeUrl = `http://127.0.0.1:${(home.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "dev-session-"));
    writeFileSync(join(dir, "home.json"), JSON.stringify({ url: homeUrl, token: "laterdog_sess_devtools" }));
    const proxy = await startHomeProxy({ session: join(dir, "home.json"), port: 0 });
    try {
      const ready = await fetch(`${proxy.url}${READY_PATH}`);
      expect(await ready.json()).toEqual({ ok: true, home: homeUrl });
      expect(seen).toEqual([]);
      const sent = await fetch(`${proxy.url}/api/bots/b1/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: "a=b" }, body: JSON.stringify({ text: "from Dev" }) });
      expect(sent.status).toBe(202);
      expect(seen).toEqual([{ path: "/api/bots/b1/messages", authorization: "Bearer laterdog_sess_devtools", body: JSON.stringify({ text: "from Dev" }) }]);
      expect((await fetch(`${proxy.url}/src/main.tsx`)).status).toBe(404);
    } finally {
      proxy.server.close();
      home.close();
    }
  });
});

describe("pairing while the home wakes", async () => {
  const { pairingGrant } = await import("./dev-connect.mjs");

  it("asks again while the home is not ready and stops on any other answer", async () => {
    let asks = 0;
    const grant = await pairingGrant(async () => {
      asks += 1;
      if (asks < 3) throw new CloudRefusal(409, "not_ready");
      return { code: "ABCD-EFGH-JKLM" };
    }, { waitMs: 1_000, retryMs: 1 });
    expect(grant).toEqual({ code: "ABCD-EFGH-JKLM" });
    expect(asks).toBe(3);
    await expect(pairingGrant(async () => { throw new CloudRefusal(403, "forbidden"); }, { waitMs: 1_000, retryMs: 1 })).rejects.toThrow(/403/);
  });
});

describe("the phone away from home", async () => {
  const { phoneAddresses, plan, savedTunnel } = await import("./dev-loop.mjs");

  it("uses the private tunnel addresses when this Mac has the tunnel, and this Wi-Fi otherwise", () => {
    expect(phoneAddresses({ lan: "192.168.1.20", tunnel: { token: "x".repeat(60) } })).toEqual({ metro: "https://dev-metro.later.dog", probe: "https://dev-probe.later.dog", open: "exps://dev-metro.later.dog" });
    expect(phoneAddresses({ lan: "192.168.1.20", tunnel: null }).open).toBe("http://192.168.1.20:8081/_expo/link?choice=expo-go&platform=ios");
  });

  it("runs the tunnel with its token in the environment, never on the command line, and keeps the Mac awake", () => {
    const tunnel = { token: "t".repeat(60) };
    const services = plan({ home: { kind: "mine", account: null, session: "/x/my-home.session.json" }, lan: "192.168.1.20", phoneRepo: "/nowhere", tunnel });
    const run = services.find((service) => service.name === "tunnel")!;
    expect(run.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(run.env.TUNNEL_TOKEN).toBe(tunnel.token);
    expect(services.map((service) => service.name)).toContain("awake");
  });

  it("ignores a missing or broken tunnel file", () => {
    expect(savedTunnel("/nowhere.json", () => { throw new Error("missing"); })).toBeNull();
    expect(savedTunnel("/x.json", () => "{\"token\":\"short\"}")).toBeNull();
  });
});
