import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SCREENSHOT = JSON.stringify([{
  name: "mcp__browser__agent_browser_screenshot",
  output: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }],
}]);

describe.skipIf(process.platform === "win32")("images a dog takes mid-turn", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const images = (bot: any) => bot.messages.filter((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "image"));
  const savedPngs = () => {
    const dir = join(home, ".laterdog", "attachments");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".png")) : [];
  };
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const startTurn = async (text: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeShots", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => images(await getBot(created.id)).length > 0, "the screenshot");
    return created.id as string;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-turn-images-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claudeShots: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate, FAKE_CLAUDE_TOOL_CALLS: SCREENSHOT },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, LATERDOG_SERVER_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    while (!(await fetch(`${BASE}/api/health`).then((res) => res.ok, () => false))) {
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("shows the image while the turn is still running and keeps it where it was taken", async () => {
    rmSync(finishGate, { force: true });
    const botId = await startTurn("show me the page");

    const working = await getBot(botId);
    expect(working.busy).toBe(true);
    const [shot] = images(working);
    expect(shot).toMatchObject({ role: "bot", kind: "text", text: "" });
    expect(shot.turnId).toEqual(expect.any(String));
    expect(shot.attachments).toEqual([expect.objectContaining({ kind: "image", mime: "image/png" })]);

    writeFileSync(finishGate, "finish");
    await waitFor(async () => (await getBot(botId)).busy === false, "the turn to settle");
    const settled = await getBot(botId);
    expect(images(settled).map((m: any) => m.id)).toEqual([shot.id]);
    const reply = settled.messages.find((m: any) => m.text === "reply to: show me the page");
    expect(reply).toMatchObject({ turnId: shot.turnId, turnTerminal: true });
    expect(reply.attachments).toBeUndefined();
    const order = settled.messages.map((m: any) => m.id);
    expect(order.indexOf(shot.id)).toBeLessThan(order.indexOf(reply.id));
  }, 60_000);

  it("keeps an image taken before the person pressed Stop", async () => {
    rmSync(finishGate, { force: true });
    const before = savedPngs().length;
    const botId = await startTurn("take a screenshot and keep going");
    const [shot] = images(await getBot(botId));
    expect(savedPngs()).toHaveLength(before + 1);

    await api("POST", `/api/bots/${botId}/interrupt`);
    await waitFor(async () => (await getBot(botId)).busy === false, "the stop to settle");

    const stopped = await getBot(botId);
    expect(images(stopped).map((m: any) => m.id)).toEqual([shot.id]);
    expect(images(stopped)[0].attachments).toEqual(shot.attachments);
    expect(savedPngs()).toHaveLength(before + 1);
  }, 60_000);
});
