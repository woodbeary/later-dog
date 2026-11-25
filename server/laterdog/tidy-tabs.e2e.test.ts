import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { leasePort, leasePortBlock } from "../testing/ports.ts";
import { MAX_TABS_PER_COMPUTER } from "./cloud-tabs.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");
const INCLUDED = `box_laterdog_${randomUUID()}`;
const FRAME = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const CHROMIUM = [
  process.env.LATERDOG_BROWSER_STEPS_CHROMIUM,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

interface Receipt {
  scenario: string;
  tabsBefore: number;
  tabsMostDuringTurn: number;
  tabsAfterTurn: number;
  browserKbDuringTurn: number;
  browserKbAfterTurn: number;
  replies: string[];
}

describe.skipIf(!CHROMIUM)("a dog's cloud computer keeps one tidy browser", () => {
  let home = "";
  let base = "";
  let finishFile = "";
  let dumpFile = "";
  let output = "";
  let cdpPort = 0;
  let server: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let relay: Server;
  let site: Server;
  let origin = "";
  const receipts: Receipt[] = [];
  const boxes: Array<{ id: string; state: string; name?: string }> = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => null)) as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBeLessThan(400);
    return parsed;
  };
  async function until<T>(
    read: () => T | Promise<T>,
    accept: (value: T) => boolean,
    ms = 20_000,
  ): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) return value;
      await sleep(100);
    }
  }
  const tabs = async () =>
    (
      (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{
        type: string;
        url: string;
      }>
    )
      .filter((target) => target.type === "page")
      .map((target) => target.url);
  const browserKb = () => {
    const rows = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const tree = new Set([browser!.pid!]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, ppid] of rows)
        if (!tree.has(pid!) && tree.has(ppid!)) {
          tree.add(pid!);
          grew = true;
        }
    }
    return rows
      .filter(([pid]) => tree.has(pid!))
      .reduce((total, [, , rss]) => total + (rss ?? 0), 0);
  };
  const startTurn = async (botId: string, text: string) => {
    rmSync(dumpFile, { force: true });
    rmSync(finishFile, { force: true });
    await api("POST", `/api/bots/${botId}/messages`, { text });
    const sent = await until<any>(() => {
      if (!existsSync(dumpFile)) return null;
      try {
        return JSON.parse(readFileSync(dumpFile, "utf8"));
      } catch {
        return null;
      }
    }, Boolean);
    expect(sent, output.slice(-3000)).toBeTruthy();
    const env = sent.mcpConfig.mcpServers.computer.env;
    return async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(
        new URL("/api/internal/computer/mcp", env.LATERDOG_HARNESS_URL),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.LATERDOG_MCP_TOKEN}`,
          },
          body: JSON.stringify({ method: "tools/call", params: { name, arguments: args } }),
        },
      );
      const body = (await response.json()) as any;
      expect(
        body.result,
        `${response.status} ${JSON.stringify(body)}\n${output.slice(-3000)}`,
      ).toBeDefined();
      return body.result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    };
  };
  const finishTurn = async (botId: string) => {
    writeFileSync(finishFile, "finish");
    await until(
      async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId)?.busy,
      (busy) => busy === false,
      30_000,
    );
  };
  const cloudBot = async (name: string) => {
    const { bot } = await api("POST", "/api/bots", { name });
    await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      browser: false,
      computer: "cloud",
    });
    return bot as { id: string };
  };
  let dog: { id: string } | null = null;
  const scenario = async (
    name: string,
    settled: number,
    work: (
      call: Awaited<ReturnType<typeof startTurn>>,
      seen: () => Promise<void>,
    ) => Promise<string[]>,
  ) => {
    const bot = (dog ??= await cloudBot("Researcher"));
    const tabsBefore = (await tabs()).length;
    let most = tabsBefore;
    let peakKb = browserKb();
    const seen = async () => {
      most = Math.max(most, (await tabs()).length);
      peakKb = Math.max(peakKb, browserKb());
    };
    const call = await startTurn(bot.id, name);
    const replies = await work(call, seen);
    await seen();
    await finishTurn(bot.id);
    const after = await until(
      () => tabs(),
      (open) => open.length <= settled,
      30_000,
    );
    await sleep(1_500);
    const receipt: Receipt = {
      scenario: name,
      tabsBefore,
      tabsMostDuringTurn: most,
      tabsAfterTurn: (await tabs()).length,
      browserKbDuringTurn: peakKb,
      browserKbAfterTurn: browserKb(),
      replies,
    };
    receipts.push(receipt);
    return { receipt, after };
  };

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><title>Page ${req.url}</title><h1>Page ${req.url}</h1>${"<p>Filler text for a page with some weight.</p>".repeat(400)}`,
      );
    });
    await new Promise<void>((settle) => site.listen(0, "127.0.0.1", settle));
    origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

    home = mkdtempSync(join(tmpdir(), "laterdog-tidy-tabs-"));
    const data = join(home, "data");
    const computerHome = join(home, "computer");
    const bin = join(home, "bin");
    for (const dir of [data, computerHome, bin]) mkdirSync(dir, { recursive: true });
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    cdpPort = await leasePort();
    browser = spawn(
      CHROMIUM!,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${join(home, "profile")}`,
        "--window-size=1280,800",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    await until(
      () =>
        fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(
          (response) => response.ok,
          () => false,
        ),
      Boolean,
      20_000,
    );
    writeFileSync(
      join(bin, "xdg-open"),
      `#!/bin/sh\nexec curl -s -X PUT "http://127.0.0.1:$LATERDOG_PAGE_CDP_PORT/json/new?$1" >/dev/null\n`,
    );
    chmodSync(join(bin, "xdg-open"), 0o755);

    relay = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://relay.test");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const path = url.pathname.replace(/^\/relay\/api\/box\/v1/, "");
        if (req.headers.authorization !== `Bearer ${INCLUDED}`)
          return send(401, { ok: false, code: "unauthorized" });
        if (path === "/boxes" && req.method === "GET")
          return send(200, { ok: true, boxes, pageInfo: { nextCursor: null } });
        if (path === "/boxes" && req.method === "POST") {
          const asked = raw ? (JSON.parse(raw) as { name?: string }) : {};
          const row = {
            id: `bx_${"23456789abcdefgh"[boxes.length]}3456789`,
            state: "ready",
            ...(asked.name ? { name: asked.name } : {}),
          };
          boxes.push(row);
          return send(201, { ok: true, box: row });
        }
        const [, id = "", verb = ""] = /^\/boxes\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
        const row = boxes.find((candidate) => candidate.id === id);
        if (!row) return send(404, { ok: false, code: "not_found" });
        if (!verb && req.method === "PATCH") {
          row.name = (raw ? (JSON.parse(raw) as { name?: string }) : {}).name;
          return send(200, { ok: true, box: row });
        }
        if (!verb && req.method === "GET") return send(200, { ok: true, box: row });
        if (verb === "resume" && req.method === "POST") return send(200, { ok: true, box: row });
        if (verb === "desktop" && req.method === "POST")
          return send(200, { desktopUrl: `https://desktop.invalid/${row.id}` });
        if (verb === "commands" && req.method === "POST") {
          const asked = String((raw ? JSON.parse(raw) : {}).command ?? "");
          if (!/\/json\/(list|close)|--input-type=module/.test(asked))
            return send(200, { exitCode: 0, stdout: "captured", stderr: "" });
          const command = asked
            .replace("exec env -i", `exec env -i LATERDOG_PAGE_CDP_PORT=${cdpPort}`)
            .replace(
              'PATH="/usr/local/sbin',
              `PATH="${bin}:${dirname(process.execPath)}:/usr/local/sbin`,
            );
          const child = spawn("bash", ["-c", command], {
            env: { HOME: computerHome, PATH: process.env.PATH ?? "" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("close", (code) => send(200, { exitCode: code, stdout, stderr }));
          return;
        }
        if (verb === "artifacts" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": String(FRAME.length),
          });
          return res.end(FRAME);
        }
        send(404, { ok: false, code: "not_found" });
      });
    });
    await new Promise<void>((settle) => relay.listen(0, "127.0.0.1", settle));
    const relayBase = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({
        features: { pageTools: true },
        instances: {
          claude: {
            driver: "claudeAgent",
            config: { cli: FAKE_CLAUDE },
            environment: {
              FAKE_CLAUDE_MODE: "slow",
              FAKE_CLAUDE_DUMP: dumpFile,
              FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile,
            },
          },
        },
      }),
    );
    const port = await leasePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        LATERDOG_HOME: data,
        TEMP: home,
        TMP: home,
        TMPDIR: home,
        LATERDOG_SERVER_PORT: String(port),
        LATERDOG_WEBHOOK_PORT: String(port + 1),
        LATERDOG_BOX_API: `${relayBase}/own-key-must-not-be-used`,
        LATERDOG_CLOUD_BOAT_URL: `${relayBase}/relay/api/box/v1`,
        LATERDOG_CLOUD_BOAT_TOKEN: INCLUDED,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    server.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    const up = await until(
      async () => {
        if (server!.exitCode !== null) throw new Error(`the server exited:\n${output}`);
        try {
          return (await fetch(`${base}/api/health`)).ok;
        } catch {
          return false;
        }
      },
      Boolean,
      30_000,
    );
    if (!up) throw new Error(`the server did not answer:\n${output.slice(-3000)}`);
  }, 90_000);

  afterAll(async () => {
    if (process.env.LATERDOG_TIDY_TABS_RECEIPT)
      writeFileSync(
        process.env.LATERDOG_TIDY_TABS_RECEIPT,
        `${JSON.stringify(receipts, null, 2)}\n`,
      );
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    browser?.kill("SIGTERM");
    if (relay)
      await new Promise<void>((settle) => {
        relay.closeAllConnections();
        relay.close(() => settle());
      });
    if (site)
      await new Promise<void>((settle) => {
        site.closeAllConnections();
        site.close(() => settle());
      });
    await sleep(500);
    if (home) await removeTempDir(home);
  });

  it("does a five-page research task in one tab and leaves that one page on screen when the turn ends", async () => {
    const { receipt } = await scenario("five pages, one after another", 1, async (call, seen) => {
      const replies: string[] = [];
      for (const n of [1, 2, 3, 4, 5]) {
        const result = await call("open_url", { url: `${origin}/page/${n}` });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        replies.push(result.content[0]?.text ?? "");
        await seen();
      }
      return replies;
    });
    expect(receipt.tabsMostDuringTurn).toBe(1);
    expect(receipt.tabsAfterTurn).toBe(1);
    expect(await tabs()).toEqual([`${origin}/page/5`]);
    expect(receipt.replies.at(-1)).toContain("Opened in your tab");
  }, 90_000);

  it("opens a second tab only to compare two pages, and closes it when the turn ends", async () => {
    const { receipt } = await scenario("two pages side by side", 1, async (call, seen) => {
      const replies: string[] = [];
      for (const [url, extra] of [
        [`${origin}/plan/basic`, {}],
        [`${origin}/plan/pro`, { new_tab: true }],
      ] as const) {
        const result = await call("open_url", { url, ...extra });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        replies.push(result.content[0]?.text ?? "");
        await seen();
      }
      expect(await tabs()).toHaveLength(2);
      return replies;
    });
    expect(receipt.tabsMostDuringTurn).toBe(2);
    expect(receipt.tabsAfterTurn).toBe(1);
    expect(await tabs()).toEqual([`${origin}/plan/pro`]);
  }, 90_000);

  it("never lets a turn hold more than the cap, closing its oldest idle tab first, and keeps a page it was told to leave open", async () => {
    const { receipt } = await scenario("eight new tabs, one kept", 2, async (call, seen) => {
      const replies: string[] = [];
      const kept = await call("open_url", {
        url: `${origin}/keep/me`,
        new_tab: true,
        keep_open: true,
      });
      expect(kept.isError, JSON.stringify(kept)).not.toBe(true);
      for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        const result = await call("open_url", { url: `${origin}/many/${n}`, new_tab: true });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        replies.push(result.content[0]?.text ?? "");
        await seen();
        expect((await tabs()).length).toBeLessThanOrEqual(MAX_TABS_PER_COMPUTER);
      }
      const open = await tabs();
      expect(open[0]).toBe(`${origin}/many/7`);
      expect(open).toContain(`${origin}/keep/me`);
      expect(open).not.toContain(`${origin}/many/1`);
      return replies;
    });
    expect(receipt.tabsMostDuringTurn).toBeLessThanOrEqual(MAX_TABS_PER_COMPUTER);
    expect((await tabs()).sort()).toEqual([`${origin}/keep/me`, `${origin}/many/7`]);
  }, 120_000);
});
