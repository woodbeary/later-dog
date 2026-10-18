import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-laterdog.ts";
import { PERSON_DENIED } from "./person-denied.ts";

it("hands the engine one fixed denial whatever the client sent with Don't allow", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  const sockets: Socket[] = [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const card = async (thread: string, id: string) =>
    ((await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages as any[]).find((message) => message.card?.requestId === id)?.card;
  const ask = async (socketPath: string, command: string) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const id = randomUUID();
    let buffer = "";
    const reply = new Promise<any>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", () => reject(new Error(`Permission socket closed before its reply: ${id}`)));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]!));
      });
    });
    void reply.catch(() => {});
    socket.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command } }) + "\n");
    return { id, reply };
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Denial fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    const dump = join(dataDir, "fake-claude-dump.json");
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold while a denial is checked." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    const socketPath = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.dog.args.at(-1) as string;

    for (const [route, body] of [
      [`/api/threads/${bot.threadId}/respond`, { message: "Declined." }],
      [`/api/bots/${bot.id}/respond`, { threadId: bot.threadId, message: "Try rm -rf in a different way instead." }],
      [`/api/threads/${bot.threadId}/respond`, {}],
    ] as const) {
      const request = await ask(socketPath, "rm -rf ./build");
      await expect.poll(async () => Boolean(await card(bot.threadId, request.id))).toBe(true);
      expect((await api("POST", route, { ...body, requestId: request.id, behavior: "deny" })).outcome).toBe("rejected");
      expect(await request.reply).toMatchObject({ id: request.id, behavior: "deny", message: PERSON_DENIED });
    }
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    console.info(`Fixed denial reached the fake engine; isolated log: ${logPath}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await fixture.close();
  }
}, 60_000);
