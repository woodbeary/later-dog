import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("keeps no saved command: a card offers none, an answer saves none, an old rule answers nothing and lists as no longer used", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  const sockets: Socket[] = [];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const card = async (thread: string, id: string) => (await messages(thread)).find(message => message.card?.requestId === id)?.card;
  const start = async (bot: any, thread = bot.threadId) => {
    const dump = join(dataDir, "fake-claude-dump.json");
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "Hold this verification task while its native command approvals are exercised." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.dog.args.at(-1) as string;
  };
  const ask = async (socketPath: string, command: string) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const id = randomUUID();
    let buffer = "";
    const reply = new Promise<any>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", () => reject(new Error(`Permission socket closed before its reply: ${id}`)));
      socket.on("data", chunk => {
        buffer += chunk;
        if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]!));
      });
    });
    void reply.catch(() => {});
    socket.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command } }) + "\n");
    return { id, reply };
  };
  const stop = (bot: any, thread = bot.threadId) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread });
  try {
    const bot = (await api("POST", "/api/bots", { name: "Command rules fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    const rulesPath = `/api/bots/${bot.id}/command-allowlist`;
    const cwd = (await api("GET", rulesPath)).context.cwd as string;
    const command = "printf 'allowlist fixture'";
    expect((await api("POST", rulesPath, { command, cwd, providerInstanceId: "claude" }, 409)).why).toBe("stopped");

    const socket = await start(bot);
    const first = await ask(socket, command);
    await expect.poll(async () => Boolean(await card(bot.threadId, first.id))).toBe(true);
    expect((await card(bot.threadId, first.id)).commandAllowlist).toBeUndefined();
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true })).outcome).toBe("allowed-once");
    expect(await first.reply).toMatchObject({ id: first.id, behavior: "allow" });
    expect((await api("GET", rulesPath)).rules).toEqual([]);
    await stop(bot);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    writeFileSync(join(dataDir, "command-allowlist.json"), JSON.stringify({ version: 1, rules: [{ id: randomUUID(), botId: bot.id, command, cwd, providerInstanceId: "claude" }] }));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const listed = (await api("GET", `/api/bots/${bot.id}/always-allowed`)).items.filter((item: any) => item.kind === "command");
    expect(listed).toEqual([expect.objectContaining({ kind: "command", subject: command, state: "no-longer-used" })]);
    const restartedSocket = await start(bot);
    const again = await ask(restartedSocket, command);
    await expect.poll(async () => Boolean(await card(bot.threadId, again.id))).toBe(true);
    expect((await card(bot.threadId, again.id)).commandAllowlist).toBeUndefined();
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: again.id, behavior: "deny" });
    expect(await again.reply).toMatchObject({ id: again.id, behavior: "deny" });
    await stop(bot);
    await api("DELETE", `/api/bots/${bot.id}/always-allowed/${encodeURIComponent(listed[0].id)}`);
    expect((await api("GET", rulesPath)).rules).toEqual([]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
