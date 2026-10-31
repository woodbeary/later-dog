import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { detailsFill, type VaultDetailsView } from "../shared/vault.ts";
import type { SecureFormCardData } from "../shared/secure-form.ts";
import { launchVerificationServer, runControlLaterDog } from "./control-laterdog.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");
const DETAILS = { name: "Kit Fixture", email: "kit.fixture@example.com", "address-line1": "1 Fixture Way", "postal-code": "94110" };
const CHECKOUT = [
  { id: "first", label: "First name", type: "text", autocomplete: "given-name" },
  { id: "last", label: "Last name", type: "text", autocomplete: "family-name" },
  { id: "email", label: "Email", type: "email", autocomplete: "email" },
  { id: "phone", label: "Phone", type: "text", autocomplete: "tel" },
  { id: "street", label: "Address", type: "text", autocomplete: "address-line1" },
  { id: "unit", label: "Apartment", type: "text", autocomplete: "address-line2", optional: true },
  { id: "zip", label: "ZIP code", type: "text", autocomplete: "postal-code" },
];
const TYPED_PHONE = "+1 415 555 0142";

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
const gate = join(process.env.TMPDIR ?? "/tmp", `laterdog-details-gate-${process.pid}`);
const fixture = await launchVerificationServer({
  FAKE_CLAUDE_MODE: "slow",
  FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
  FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1",
  LATERDOG_TEST_VAULT_KEY: randomBytes(32).toString("base64"),
}, undefined, undefined, undefined, undefined, undefined, ["openai-compat"], `http://127.0.0.1:${address.port}`);
let exitCode = 1;
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const control = (args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]) as Promise<any>;
  const dumped = async () => {
    for (let tries = 0; tries < 150; tries += 1) {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { await new Promise((wait) => setTimeout(wait, 100)); }
    }
    throw new Error("the dog's engine never started");
  };
  const text = (answer: { result?: any }) => String(answer.result?.content?.[0]?.text ?? "");

  await api("PUT", "/api/vault/details", { details: DETAILS });
  const { bot } = await control(["new-bot", "--name", "Shopper"]);
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
  rmSync(gate, { force: true });
  rmSync(fixture.fixtureDumpPath, { force: true });
  await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Use the browser on your computer to check out the basket on shop.example.com."]);
  const connect = async () => {
    const next = mcpClient((await dumped()).mcpConfig.mcpServers.computer);
    await next.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-vault-details", version: "1" } });
    return next;
  };
  const asking = await connect();
  const opened = text(await asking.request("tools/call", { name: "request_secure_form", arguments: { title: "Delivery details", site: "shop.example.com", fields: CHECKOUT } }));
  const formId = /form_id "([\w-]+)"/.exec(opened)?.[1] ?? "";
  asking.close();
  writeFileSync(gate, "finish");
  await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
  rmSync(fixture.fixtureDumpPath, { force: true });
  const page = await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=20`) as { messages: Array<{ id: string; secureForm?: SecureFormCardData }> };
  const card = page.messages.find((message) => message.id === formId)?.secureForm;
  const saved = await api("GET", "/api/vault/details") as VaultDetailsView;
  const filled = detailsFill(card?.fields ?? [], saved.details);
  const values = { ...Object.fromEntries((card?.fields ?? []).map((field) => [field.id, ""])), ...filled, phone: TYPED_PHONE };
  const submitted = await api("POST", `/api/bots/${bot.id}/secure-forms/${formId}/submit`, { threadId: bot.activeTaskId, values, save: true }) as { card?: SecureFormCardData; saved?: boolean };
  const wokenWith = JSON.stringify(await dumped());
  await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]).catch(() => {});
  const afterwards = await api("GET", "/api/vault/details") as VaultDetailsView;
  const plain = [...Object.values(DETAILS), TYPED_PHONE];
  const checks = {
    cardKeepsTags: card?.fields.map((field) => `${field.id}:${field.autocomplete ?? ""}${field.optional ? "?" : ""}`),
    filledFromDetails: filled,
    sentAndSaved: submitted.saved === true && submitted.card?.status === "sending",
    emptyOptionalMarked: submitted.card?.fields.find((field) => field.id === "unit")?.filled === true,
    wokenToTypeTheRest: /for each field: first \(First name\), last \(Last name\), email \(Email\), phone \(Phone\), street \(Address\), zip \(ZIP code\)\..*They left Apartment empty/.test(wokenWith),
    noValueShownToDog: !plain.some((value) => `${opened}${wokenWith}`.includes(value)),
    phoneLearned: afterwards.details.tel === TYPED_PHONE,
    vaultFileSealed: !plain.some((value) => readFileSync(join(fixture.info.dataDir, "vault.json"), "utf8").includes(value)),
  };
  const ok = JSON.stringify(checks.cardKeepsTags) === JSON.stringify(CHECKOUT.map((field) => `${field.id}:${field.autocomplete}${field.optional ? "?" : ""}`))
    && Object.keys(checks.filledFromDetails).join() === "first,last,email,street,zip"
    && checks.sentAndSaved && checks.emptyOptionalMarked && checks.wokenToTypeTheRest && checks.noValueShownToDog && checks.phoneLearned && checks.vaultFileSealed;
  console.log(JSON.stringify({ ok, checks }, null, 2));
  exitCode = ok ? 0 : 1;
} finally {
  rmSync(gate, { force: true });
  await fixture.close();
  upstream.close();
}
process.exit(exitCode);
