import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";
import { edgeFetch, pairSession } from "./cloud-home-trip-check.mjs";
import { createRelay, jsonAsker } from "./dev-home-relay.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MACHINE = "h0123456789abcdef01234567";
const HOST = `${MACHINE}-home.later.dog`;
const ORIGIN = `https://${HOST}`;
const SECRET = randomBytes(32).toString("base64url");
const OFFLINE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
const BEHIND_CADDY = { "x-forwarded-for": "203.0.113.5", "x-forwarded-proto": "https", "x-forwarded-host": HOST };
const MAC_REPLY = "Fixed it here on the Mac.";
const FAKE_CLAUDE = join(ROOT, "server", "testing", "fake-claude-cli.ts");

interface Fixture { dir: string; base: string; child: ChildProcess; log: string }
const fixtures: Fixture[] = [];
let home: Fixture;
let mac: Fixture;

async function launch(name: string, extra: NodeJS.ProcessEnv): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), `laterdog-relay-${name}-`));
  const dataDir = join(dir, ".laterdog");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "chatgpt", "cursor", "grok", "kimi", "droid", "antigravity", "opencodeGo", "openaiCompat", "qwen", "hermes", "pi"]
      .map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: FAKE_CLAUDE } },
  } }));
  const port = await freePortBlock([0, 1]);
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    HOME: dir, USERPROFILE: dir, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
    LATERDOG_TEST_SEALED_PATH: "1", ...extra,
  };
  const child = spawn(process.execPath, ["--import", OFFLINE, join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const fixture: Fixture = { dir, base: `http://127.0.0.1:${port}`, child, log: "" };
  fixtures.push(fixture);
  child.stdout?.on("data", (chunk) => { fixture.log += chunk; });
  child.stderr?.on("data", (chunk) => { fixture.log += chunk; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the ${name} fixture exited:\n${fixture.log}`);
    try {
      const response = await fetch(`${fixture.base}/api/health`);
      if (response.ok && (await response.json() as { app?: string }).app === "laterdog") return fixture;
    } catch {}
    if (Date.now() > deadline) throw new Error(`the ${name} fixture did not start:\n${fixture.log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  [home, mac] = await Promise.all([
    launch("home", {
      FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_MODE: "not-logged-in",
      LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: MACHINE, LATERDOG_CLOUD_ADMIN_URL: "https://accounts.example.test",
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: SECRET, LATERDOG_PUBLIC_URL: ORIGIN,
    }),
    launch("mac", { FAKE_CLAUDE_REPLIES: JSON.stringify([MAC_REPLY]) }),
  ]);
}, 60_000);

afterAll(async () => {
  for (const fixture of fixtures.splice(0)) {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    await removeTempDir(fixture.dir);
  }
});

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms / 1000} s\n--- home ---\n${home.log.slice(-3000)}\n--- mac ---\n${mac.log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type Message = { id: string; role: string; kind?: string; text?: string };
type Bot = { id: string; name: string; threadId: string; busy?: boolean; modelSelection?: { instanceId: string } };

it("a phone's message to a mirrored dog reaches the dog on the Mac, and its reply shows on the phone and the desktop", async () => {
  const fetchHome = edgeFetch({ base: home.base, origin: ORIGIN, headers: BEHIND_CADDY });
  const [relayToken, phoneToken, desktopToken] = await Promise.all(["later.dog Dev", "later.dog iPhone", "later.dog Mac"]
    .map((label) => pairSession(fetchHome, ORIGIN, SECRET, label)));
  const homeAs = (token: string) => jsonAsker(ORIGIN, { token, fetchImpl: fetchHome as typeof fetch });
  const phone = homeAs(phoneToken);
  const desktop = homeAs(desktopToken);
  const local = jsonAsker(mac.base, { origin: mac.base });

  const { bots: macBots } = await local("GET", "/api/bots") as { bots: Bot[] };
  const macDog = macBots[0]!;
  const relay = createRelay({ home: homeAs(relayToken), local, localPoll: { deadline: Date.now() + 60_000 } });
  const mirrors = await relay.sync();
  expect(mirrors.size).toBe(macBots.length);
  const [mirrorId] = [...mirrors].find(([, bot]) => bot.id === macDog.id)!;
  expect([...(await relay.sync()).keys()], "a second sync reuses the same mirrors").toEqual([...mirrors.keys()]);

  const { bots: phoneBots } = await phone("GET", "/api/bots?messages=0") as { bots: Bot[] };
  const mirror = phoneBots.find((bot) => bot.id === mirrorId);
  expect(mirror).toMatchObject({ name: macDog.name, modelSelection: { instanceId: "mac-relay" } });

  const watching = new AbortController();
  const stream = await fetchHome(`${ORIGIN}/api/events?screens=off`, { headers: { authorization: `Bearer ${desktopToken}`, accept: "text/event-stream" }, signal: watching.signal });
  expect(stream.ok).toBe(true);
  let streamed = "";
  const reading = (async () => {
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (next.done) return;
      streamed = (streamed + decoder.decode(next.value, { stream: true })).slice(-200_000);
    }
  })();

  try {
    const text = "Please fix the login bug from your phone.";
    await phone("POST", `/api/bots/${mirror!.id}/messages`, { text, threadId: mirror!.threadId });

    await until("the relay picking up the phone's message", async () => (await relay.poll()) > 0 ? true : undefined);
    await relay.idle();

    const macMessages = (await local("GET", `/api/threads/${macDog.threadId}/messages`) as { messages: Message[] }).messages;
    expect(macMessages.some((message) => message.role === "user" && message.text === text), "the Mac dog got the phone's words").toBe(true);
    expect(macMessages.some((message) => message.role === "bot" && message.text === MAC_REPLY), "the Mac dog answered").toBe(true);

    for (const [who, ask] of [["phone", phone], ["desktop", desktop]] as const) {
      await until(`the reply showing for the ${who}`, async () => {
        const { messages } = await ask("GET", `/api/threads/${mirror!.threadId}/messages`) as { messages: Message[] };
        const user = messages.findIndex((message) => message.role === "user" && message.text === text);
        return user !== -1 && messages.slice(user + 1).some((message) => message.role === "bot" && message.text === MAC_REPLY) ? true : undefined;
      });
    }
    await until("the reply on the desktop's live stream", async () => streamed.includes(MAC_REPLY) ? true : undefined);
  } finally {
    watching.abort();
    await reading;
  }
}, 120_000);
