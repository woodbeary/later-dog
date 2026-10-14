import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = `ldt_${"e".repeat(43)}`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE_TOKEN = "fixture-cloudflare-token-not-real";

describe.skipIf(process.platform === "win32")("typing suggestions in the real server", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let worker: Server;
  const asked: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };

  beforeAll(async () => {
    worker = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        asked.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ completion: " the failing tests first", model: "fixture-model" }));
      });
    });
    await new Promise<void>((ready) => worker.listen(0, "127.0.0.1", ready));
    const workerPort = (worker.address() as AddressInfo).port;
    home = mkdtempSync(join(tmpdir(), "laterdog-typing-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    writeFileSync(join(home, ".laterdog", "computers-trial.json"), JSON.stringify({ api: `http://127.0.0.1:${workerPort}/v1`, confirmed: true, included: ["decisions", "voice", "ai"] }));
    writeFileSync(join(home, ".laterdog", "computers-trial-key"), `${KEY}\n`);
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        LATERDOG_SERVER_PORT: String(PORT),
        LATERDOG_WEBHOOK_PORT: String(PORT + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    while (!(await fetch(`${BASE}/api/health`).then((res) => res.ok, () => false))) {
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((resolve) => (child && child.exitCode === null ? child.once("exit", resolve) : resolve(null)));
    await new Promise((done) => worker.close(done));
    rmSync(home, { recursive: true, force: true });
  });

  it("says in Settings what is set up, without a token", async () => {
    const config = (await api("GET", "/api/config")).body;
    expect(config.typing).toEqual({ enabled: true, included: true, cloudflare: { configured: false, accountId: "", model: "@cf/meta/llama-3.2-3b-instruct" }, ranking: false });
    expect(config.features.typingSuggestions).toBe(true);
  });

  it("finishes a sentence through later.dog's service with the installation's key, sending only the chat context", async () => {
    const answer = await api("POST", "/api/typing/complete", {
      prefix: "Please fix",
      dog: "Rex",
      messages: [{ role: "dog", text: "Two tests fail. Key sk-" + "a1".repeat(16) }, { role: "person", text: "ok" }],
      phrasing: ["Can you look at"],
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ completion: " the failing tests first", source: "cloud" });
    const sent = asked.at(-1)!;
    expect(sent.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.keys(sent.body).sort()).toEqual(["dog", "messages", "phrasing", "prefix"]);
    expect(JSON.stringify(sent.body)).not.toContain("sk-");
  });

  it("sends nothing for text that looks like a secret", async () => {
    const before = asked.length;
    const answer = await api("POST", "/api/typing/complete", { prefix: `my key is sk-${"a1".repeat(16)}` });
    expect(answer.body).toEqual({ completion: "", reason: "sensitive" });
    expect(asked).toHaveLength(before);
  });

  it("keeps the Cloudflare token out of every answer and uses the person's account once set", async () => {
    const saved = await api("PATCH", "/api/config", { typing: { accountId: ACCOUNT, token: CLOUDFLARE_TOKEN } });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(CLOUDFLARE_TOKEN);
    const config = await api("GET", "/api/config");
    expect(config.text).not.toContain(CLOUDFLARE_TOKEN);
    expect(config.body.typing.cloudflare).toMatchObject({ configured: true, accountId: ACCOUNT });
    expect(readFileSync(join(home, ".laterdog", "config.json"), "utf8")).toContain(CLOUDFLARE_TOKEN);
    await api("PATCH", "/api/config", { typing: { accountId: "", token: "" } });
    expect((await api("GET", "/api/config")).body.typing.cloudflare.configured).toBe(false);
  });

  it("refuses a bad Cloudflare account id", async () => {
    expect((await api("PATCH", "/api/config", { typing: { accountId: "nope" } })).status).toBe(400);
  });

  it("stops completely when the person turns it off", async () => {
    const before = asked.length;
    expect((await api("PATCH", "/api/config", { features: { typingSuggestions: false } })).body.typing.enabled).toBe(false);
    expect((await api("POST", "/api/typing/complete", { prefix: "Please fix" })).body).toEqual({ completion: "", reason: "off" });
    expect(asked).toHaveLength(before);
    await api("PATCH", "/api/config", { features: { typingSuggestions: true } });
    expect((await api("GET", "/api/config")).body.typing.enabled).toBe(true);
  });
});
