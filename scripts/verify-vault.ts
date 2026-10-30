import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { launchVerificationServer, runControlLaterDog } from "./control-laterdog.ts";
import { fixtureApi, parkUntilSignal } from "./testing/preview-fixture.ts";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");
const PASSWORD = "correct horse battery staple";
const SIGN_IN = [{ id: "email", label: "Email", type: "email" }, { id: "password", label: "Password", type: "password" }];

function mcpClient(server: { command: string; args: string[]; env: Record<string, string> }) {
  const child = spawn(server.command, server.args, { env: { ...server.env, PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let nextId = 1;
  const waiting = new Map<number, (message: { result?: any; error?: unknown }) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (method: string, params: unknown = {}) => new Promise<{ result?: any; error?: unknown }>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const close = () => { if (child.exitCode === null) child.kill(); };
  return { request, close };
}

const commands: string[] = [];
const rows: Array<{ id: string; name: string; state: string }> = [];
const upstream = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://fixture").pathname;
  let raw = "";
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader("content-type", "application/json");
  if (path === "/v1/models") return res.end(JSON.stringify({ data: [] }));
  if (path.endsWith("/prompt")) {
    res.statusCode = 409;
    return res.end(JSON.stringify({ ok: false, code: "provider_not_configured", message: "Prompting is locked." }));
  }
  if (path === "/boxes" && req.method === "POST") {
    const row = { id: `bx_${String(rows.length + 2).repeat(8)}`, name: body.name, state: "idle" };
    rows.push(row);
    return res.end(JSON.stringify({ box: row }));
  }
  if (path === "/boxes") return res.end(JSON.stringify({ boxes: rows }));
  if (path.endsWith("/commands")) {
    commands.push(String(body.command));
    return res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
  }
  if (path.endsWith("/artifacts")) {
    res.setHeader("content-type", "image/jpeg");
    return res.end(JPEG);
  }
  if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
  const row = rows.find((entry) => path === `/boxes/${entry.id}`);
  if (row) return res.end(JSON.stringify({ box: row }));
  res.end("{}");
});
await new Promise<void>((ready) => upstream.listen(0, "127.0.0.1", ready));
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("the cloud computer stand-in did not start");
const origin = `http://127.0.0.1:${address.port}`;
const out = process.argv[2];
const gateDir = process.env.TMPDIR ?? "/tmp";
const gate = join(gateDir, `laterdog-vault-gate-${process.pid}`);
const fixture = await launchVerificationServer({
  FAKE_CLAUDE_MODE: "slow",
  FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
  FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1",
  LATERDOG_TEST_VAULT_KEY: randomBytes(32).toString("base64"),
}, undefined, undefined, undefined, undefined, undefined, ["openai-compat"], origin);
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const control = (args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]) as Promise<any>;
  const dumped = async () => {
    for (let tries = 0; tries < 150; tries += 1) {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { await new Promise((wait) => setTimeout(wait, 100)); }
    }
    throw new Error("the dog's engine never started");
  };
  const askForSignIn = async (botId: string, threadId: string, site: string) => {
    rmSync(gate, { force: true });
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send", "--bot", botId, "--task", threadId, "--text", "Use the browser on your computer to sign in."]);
    const client = mcpClient((await dumped()).mcpConfig.mcpServers.computer);
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-vault", version: "1" } });
      const opened = await client.request("tools/call", { name: "request_secure_form", arguments: { title: `Sign in to ${site}`, site, fields: SIGN_IN } });
      const text = String(opened.result?.content?.[0]?.text ?? "");
      const formId = /form_id "([\w-]+)"/.exec(text)?.[1] ?? "";
      const typed = text.includes("already filled") && formId
        ? await client.request("tools/call", { name: "fill_secure_field", arguments: { form_id: formId, field_id: "password", x: 640, y: 400, submit: true } })
        : null;
      return { text, formId, typed: typed ? String(typed.result?.content?.[0]?.text ?? "") : null };
    } finally {
      client.close();
      writeFileSync(gate, "finish");
      await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"]);
    }
  };

  const { bot } = await control(["new-bot", "--name", "Signer"]);
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
  await api("POST", "/api/vault/logins", { site: "example.com", username: "kit@example.com", password: PASSWORD, note: "Fixture login" });
  await api("POST", "/api/vault/logins", { site: "paypal.com", username: "kit", password: "another fixture password" });
  const asked = await askForSignIn(bot.id, bot.activeTaskId, "accounts.example.com");
  const lookalikeTask = (await api("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId as string;
  await askForSignIn(bot.id, lookalikeTask, "paypa1.com");
  const continueFile = join(fixture.info.dataDir, "continue");
  const info = { ...fixture.info, botId: bot.id, signInTask: bot.activeTaskId, lookalikeTask, firstAsk: asked.text, continueFile };
  console.log(JSON.stringify(info));
  if (out) writeFileSync(out, fixture.info.url);
  while (!existsSync(continueFile)) await new Promise((wait) => setTimeout(wait, 500));
  const before = commands.length;
  const autoTask = (await api("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId as string;
  const auto = await askForSignIn(bot.id, autoTask, "accounts.example.com");
  const typedBase64 = commands.slice(before).some((command) => command.includes(Buffer.from(PASSWORD).toString("base64")));
  const checks = {
    filledWithoutAsking: auto.text.includes("already filled"),
    typedTheSavedPassword: typedBase64,
    passwordNeverInPlainCommands: !commands.some((command) => command.includes(PASSWORD)),
    passwordNeverInToolAnswers: !`${asked.text}${auto.text}${auto.typed ?? ""}`.includes(PASSWORD),
    vaultFileSealed: !readFileSync(join(fixture.info.dataDir, "vault.json"), "utf8").includes(PASSWORD),
    autoTask,
    toolAnswer: auto.text,
    typedAnswer: auto.typed,
  };
  writeFileSync(join(fixture.info.dataDir, "vault-checks.json"), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify({ checks }));
  await parkUntilSignal();
} finally {
  rmSync(gate, { force: true });
  await fixture.close();
  upstream.close();
}
