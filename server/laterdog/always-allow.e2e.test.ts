import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

it("asks once with Always, then answers for the dog in every chat and after a restart until removed", async () => {
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
  const card = async (thread: string, id: string) =>
    (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages.find((message: any) => message.card?.requestId === id)?.card;
  const shownCard = async (thread: string, id: string) => {
    await expect.poll(async () => Boolean(await card(thread, id)), { timeout: 10_000 }).toBe(true);
    return card(thread, id);
  };
  const dog = async (id: string) => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === id);
  const start = async (bot: any, thread = bot.threadId) => {
    const dump = join(dataDir, "fake-claude-dump.json");
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "Hold this task while its approvals are exercised." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.dog.args.at(-1) as string;
  };
  const ask = async (socketPath: string, tool: string, input: Record<string, unknown>) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const id = randomUUID();
    let buffer = "";
    const reply = new Promise<any>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", () => reject(new Error(`Permission socket closed before its reply: ${id}`)));
      socket.setTimeout(15_000, () => socket.destroy(new Error(`Permission reply timed out: ${id}`)));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        socket.setTimeout(0);
        resolve(JSON.parse(buffer.split("\n")[0]!));
      });
    });
    void reply.catch(() => {});
    socket.write(JSON.stringify({ t: "ask", id, tool, input }) + "\n");
    return { id, reply };
  };
  const bash = (socketPath: string, command: string) => ask(socketPath, "Bash", { command });
  const stop = (bot: any, thread = bot.threadId) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread });
  const answeredByHome = async (thread: string, request: { id: string; reply: Promise<any> }) => {
    expect(await request.reply).toMatchObject({ id: request.id, behavior: "allow" });
    expect(await card(thread, request.id)).toBeUndefined();
    await expect.poll(async () => (await api("GET", "/api/decisions")).decisions
      .some((row: any) => row.requestId === request.id && row.source === "always-allow")).toBe(true);
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Always fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    const folder = (await api("GET", `/api/bots/${bot.id}/command-allowlist`)).context.cwd as string;
    const socket = await start(bot);

    const first = await bash(socket, "git status");
    const offered = await shownCard(bot.threadId, first.id);
    expect(offered).toMatchObject({ allowKey: "run:git status" });
    expect(offered.allowSession).toBeUndefined();
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", scope: "always" });
    expect(await first.reply).toMatchObject({ id: first.id, behavior: "allow" });
    expect((await dog(bot.id)).alwaysAllow).toContain("run:git status");
    expect((await card(bot.threadId, first.id)).answerScope).toBe("always");

    await answeredByHome(bot.threadId, await bash(socket, "git status"));
    const wider = await bash(socket, "git status --exec=x");
    expect((await shownCard(bot.threadId, wider.id)).allowKey).toBe(`exact:${folder} :: git status --exec=x`);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: wider.id, behavior: "deny" });
    expect(await wider.reply).toMatchObject({ behavior: "deny" });

    const build = await bash(socket, "make build");
    expect((await shownCard(bot.threadId, build.id)).allowKey).toBe(`exact:${folder} :: make build`);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: build.id, behavior: "allow", scope: "always" });
    expect(await build.reply).toMatchObject({ behavior: "allow" });
    await answeredByHome(bot.threadId, await bash(socket, "make build"));

    const other = await bash(socket, "ls sub");
    expect(await shownCard(bot.threadId, other.id)).toMatchObject({ allowKey: "run:ls" });
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: other.id, behavior: "allow" });
    expect(await other.reply).toMatchObject({ behavior: "allow" });
    expect((await card(bot.threadId, other.id)).answerScope).toBe("once");
    const otherAgain = await bash(socket, "ls sub");
    expect(await shownCard(bot.threadId, otherAgain.id)).toMatchObject({ allowKey: "run:ls" });
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: otherAgain.id, behavior: "deny" });
    expect(await otherAgain.reply).toMatchObject({ behavior: "deny" });

    const email = await ask(socket, "mcp__gmail__send_email", { to: "someone@example.com" });
    const emailCard = await shownCard(bot.threadId, email.id);
    expect(emailCard.allowKey).toBeUndefined();
    expect(emailCard.allowSession).toBeUndefined();
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: email.id, behavior: "deny" });
    expect(await email.reply).toMatchObject({ behavior: "deny" });

    const write = await ask(socket, "Write", { file_path: join(folder, "notes.txt"), content: "x" });
    expect(await shownCard(bot.threadId, write.id)).toMatchObject({ allowKey: "files:edit" });
    await api("POST", `/api/bots/${bot.id}/always-allow`, { threadId: bot.threadId, allowKey: "files:edit" });
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: write.id, behavior: "allow", scope: "always" });
    expect(await write.reply).toMatchObject({ behavior: "allow" });
    await answeredByHome(bot.threadId, await ask(socket, "Edit", { file_path: join(folder, "other.txt"), old_string: "a", new_string: "b" }));
    const outsideWrite = await ask(socket, "Write", { file_path: "/etc/laterdog-always-fixture", content: "x" });
    expect((await shownCard(bot.threadId, outsideWrite.id)).allowKey).toBeUndefined();
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: outsideWrite.id, behavior: "deny" });
    await stop(bot);

    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another chat" }, 201)).task;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${sibling.threadId}`, { approvalMode: "ask" });
    const siblingSocket = await start(bot, sibling.threadId);
    await answeredByHome(sibling.threadId, await bash(siblingSocket, "git status"));
    const elsewhere = await bash(siblingSocket, "make build");
    expect((await shownCard(sibling.threadId, elsewhere.id)).allowKey).not.toBe(`exact:${folder} :: make build`);
    await api("POST", `/api/threads/${sibling.threadId}/respond`, { requestId: elsewhere.id, behavior: "deny" });
    expect(await elsewhere.reply).toMatchObject({ behavior: "deny" });
    await stop(bot, sibling.threadId);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const restartedSocket = await start(bot);
    await answeredByHome(bot.threadId, await bash(restartedSocket, "git status"));

    await api("DELETE", `/api/bots/${bot.id}/always-allow?key=${encodeURIComponent("run:git status")}`);
    expect((await dog(bot.id)).alwaysAllow ?? []).not.toContain("run:git status");
    const removed = await bash(restartedSocket, "git status");
    expect(await shownCard(bot.threadId, removed.id)).toMatchObject({ allowKey: "run:git status" });
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: removed.id, behavior: "deny" });
    expect(await removed.reply).toMatchObject({ behavior: "deny" });
    await stop(bot);
    console.info(`Always-allow real-server verification passed; isolated log: ${logPath}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 150_000);
