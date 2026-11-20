import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import type { SecureFormCardData } from "../shared/secure-form.ts";
import type { VaultLogin, VaultOffers, VaultView } from "../shared/vault.ts";
import { launchVerificationServer, runControlLaterDog } from "./control-laterdog.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");
const SIGN_IN = [{ id: "email", label: "Email", type: "email" }, { id: "password", label: "Password", type: "password" }];
const SITE = "accounts.example.com";
const EMAIL = "kit.fixture@example.com";
const WRONG = "fixture typo 1";
const RIGHT = "fixture right 2";
const RIGHT_AGAIN = "fixture changed 3";

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
const gate = join(process.env.TMPDIR ?? "/tmp", `laterdog-vault-saves-gate-${process.pid}`);
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
    for (let tries = 0; tries < 300; tries += 1) {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { await new Promise((wait) => setTimeout(wait, 100)); }
    }
    throw new Error("the dog's engine never started");
  };
  const text = (answer: { result?: any }) => String(answer.result?.content?.[0]?.text ?? "");
  const { bot } = await control(["new-bot", "--name", "Signer"]);
  const thread = bot.activeTaskId as string;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });

  const dogTurn = async <T>(start: () => Promise<unknown>, work: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<T>): Promise<T> => {
    rmSync(gate, { force: true });
    rmSync(fixture.fixtureDumpPath, { force: true });
    await start();
    const client = mcpClient((await dumped()).mcpConfig.mcpServers.computer);
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-vault-saves", version: "1" } });
      return await work(async (name, args) => text(await client.request("tools/call", { name, arguments: args })));
    } finally {
      client.close();
      writeFileSync(gate, "finish");
      await control(["wait", "--bot", bot.id, "--task", thread, "--timeout", "30"]);
    }
  };
  const ask = () => dogTurn(() => control(["send", "--bot", bot.id, "--task", thread, "--text", "Use the browser on your computer to sign in to example.com."]), async (call) => {
    const opened = await call("request_secure_form", { title: "Sign in to Example", site: SITE, fields: SIGN_IN });
    return /form_id "([\w-]+)"/.exec(opened)?.[1] ?? "";
  });
  const send = (formId: string, body: Record<string, unknown>) => () => api("POST", `/api/bots/${bot.id}/secure-forms/${formId}/submit`, { threadId: thread, ...body });
  const typeAndReport = (formId: string, result: string, said?: string) => async (call: (name: string, args: Record<string, unknown>) => Promise<string>) => {
    const typed = [
      await call("fill_secure_field", { form_id: formId, field_id: "email", x: 640, y: 300 }),
      await call("fill_secure_field", { form_id: formId, field_id: "password", x: 640, y: 380, submit: true }),
    ];
    const reported = await call("secure_form_result", { form_id: formId, result, ...(said ? { site_said: said } : {}) });
    return { typed, reported };
  };
  const card = async (formId: string) => {
    const page = await api("GET", `/api/threads/${thread}/messages?limit=50`) as { messages: Array<{ id: string; secureForm?: SecureFormCardData }> };
    return page.messages.find((message) => message.id === formId)?.secureForm;
  };
  const saved = async (): Promise<VaultLogin[]> => ((await api("GET", "/api/vault")) as VaultView).logins.filter((login) => login.site === "example.com");
  const typedValue = (value: string) => commands.some((command) => command.includes(Buffer.from(value).toString("base64")));

  const first = await ask();
  const wrongTry = await dogTurn(send(first, { values: { email: EMAIL, password: WRONG }, save: true }), typeAndReport(first, "rejected", "Incorrect email or password."));
  const afterWrong = { vault: await saved(), card: await card(first) };

  const rightTry = await dogTurn(send(first, { values: { email: EMAIL, password: RIGHT }, save: true }), typeAndReport(first, "signed_in"));
  const afterRight = { vault: await saved(), card: await card(first) };

  const second = await ask();
  const otherCase = await dogTurn(send(second, { values: { email: "Kit.Fixture@Example.COM", password: RIGHT_AGAIN }, save: true }), typeAndReport(second, "signed_in"));
  const afterOtherCase = { vault: await saved(), card: await card(second), offers: await api("GET", `/api/vault/offers?host=${SITE}`) as VaultOffers };

  const third = await ask();
  const fromVault = await dogTurn(send(third, { login: afterOtherCase.vault[0]?.id ?? "" }), async (call) => [
    await call("fill_secure_field", { form_id: third, field_id: "password", x: 640, y: 380, submit: true }),
    await call("secure_form_result", { form_id: third, result: "signed_in" }),
  ]);
  const afterVault = { vault: await saved(), card: await card(third) };

  const dogSaw = JSON.stringify([wrongTry, rightTry, otherCase, fromVault]);
  const disk = readFileSync(join(fixture.info.dataDir, "vault.json"), "utf8");
  const checks = {
    wrongPasswordNotSaved: afterWrong.vault.length === 0,
    formBackWithEmailKept: afterWrong.card?.status === "open" && afterWrong.card.tried?.username === EMAIL && afterWrong.card.tried.rejected === true && afterWrong.card.tried.said === "Incorrect email or password." && afterWrong.card.tried.save === true,
    dogToldNothingSaved: wrongTry.reported.includes("Nothing was saved"),
    correctedPasswordSavedOnce: afterRight.vault.length === 1 && afterRight.vault[0]?.username === EMAIL && typeof afterRight.vault[0]?.workedAt === "number",
    cardSaysSignedInAndSaved: afterRight.card?.outcome === "signed-in" && afterRight.card.vault === "saved",
    otherCaseStillOneEntry: afterOtherCase.vault.length === 1 && afterOtherCase.vault[0]?.id === afterRight.vault[0]?.id,
    otherCaseRewroteThatEntry: afterOtherCase.vault[0]?.username === "Kit.Fixture@Example.COM" && (afterOtherCase.vault[0]?.updatedAt ?? 0) > (afterRight.vault[0]?.updatedAt ?? Infinity),
    otherCaseOfferedOnce: afterOtherCase.offers.logins.length === 1,
    savedLoginMarkedWorking: afterVault.vault.length === 1 && (afterVault.vault[0]?.workedAt ?? 0) > (afterOtherCase.vault[0]?.workedAt ?? Infinity) && afterVault.card?.saved?.login === afterOtherCase.vault[0]?.id,
    passwordsNeverInPlainCommands: ![WRONG, RIGHT, RIGHT_AGAIN].some((value) => commands.some((command) => command.includes(value))),
    passwordsNeverShownToDog: ![WRONG, RIGHT, RIGHT_AGAIN].some((value) => dogSaw.includes(value)),
    vaultFileSealed: ![EMAIL, "Kit.Fixture", WRONG, RIGHT, RIGHT_AGAIN].some((value) => disk.includes(value)),
  };
  const ok = Object.values(checks).every(Boolean);
  const evidence = {
    ok,
    checks,
    notExercised: {
      typing: typedValue(WRONG) || typedValue(RIGHT) ? "typed" : "The stand-in cloud computer does not start in this fixture, so fill_secure_field answers that the computer did not start and types nothing. Typing is covered by server/cloud-computer-tools.test.ts and server/laterdog/secure-form.test.ts.",
    },
    afterWrong: { vault: afterWrong.vault, card: afterWrong.card },
    afterRight: { vault: afterRight.vault, card: afterRight.card },
    afterOtherCase: { vault: afterOtherCase.vault, card: afterOtherCase.card, offers: afterOtherCase.offers },
    afterSavedLogin: afterVault,
    dogAnswers: { wrongTry, rightTry, otherCase, fromVault },
  };
  const out = process.argv[2];
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(evidence, null, 2));
  }
  console.log(JSON.stringify(evidence, null, 2));
  exitCode = ok ? 0 : 1;
} finally {
  rmSync(gate, { force: true });
  await fixture.close();
  upstream.close();
}
process.exit(exitCode);
