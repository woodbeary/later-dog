import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function client(url: string) {
  return async (method: string, path: string, body?: unknown, status = 200) => {
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
}

describe("a send that the server already accepted", () => {
  it("is not a second message and not a second turn after a hard restart and a retried POST", async () => {
    const prompts = join(mkdtempSync(join(tmpdir(), "laterdog-sweep-prompts-")), "prompts.ndjson");
    const env = { FAKE_CLAUDE_PROMPTS: prompts };
    const fixture = await launchVerificationServer({ ...process.env, ...env });
    const { url, dataDir, logPath } = fixture.info;
    let restarted: ChildProcess | undefined;
    cleanups.push(async () => {
      await waitForExit(restarted, { signal: "SIGTERM" });
      await fixture.close();
      rmSync(join(prompts, ".."), { recursive: true, force: true });
    });
    const api = client(url);
    const bot = (await api("POST", "/api/bots", { name: "Durable send" }, 201)).bot;
    const sendId = "sweep_send_durable_0001";
    const body = { text: "ship the release notes", threadId: bot.threadId, sendId };
    const first = await api("POST", `/api/bots/${bot.id}/messages`, body, 202);
    await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).messages
      .some((message: any) => message.role === "bot" && message.kind === "text" && message.text === "hello from fake claude"), { timeout: 15_000 }).toBe(true);

    await waitForExit(fixture.child, { signal: "SIGKILL" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ ...process.env, ...env }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const retried = await api("POST", `/api/bots/${bot.id}/messages`, body, 202);
    expect(retried.message.id).toBe(first.message.id);
    const user = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).messages.filter((message: any) => message.role === "user");
    expect(user.map((message: any) => [message.sendId, message.text])).toEqual([[sendId, body.text]]);
    await delay(1_500);
    expect(readFileSync(prompts, "utf8").trim().split("\n")).toHaveLength(1);

    const clash = await fetch(`${url}/api/bots/${bot.id}/messages`, {
      method: "POST", headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ ...body, text: "different words, same send id" }),
    });
    expect(clash.status).toBe(409);
  }, 90_000);
});

describe("approval cards", () => {
  it("appear once, wait for the person, take an answer once, and never approve by themselves", async () => {
    const fixture: VerificationServer = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
    const { url, dataDir } = fixture.info;
    const sockets: Socket[] = [];
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await fixture.close();
    });
    const api = client(url);
    const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
    const cards = async (thread: string, id: string) => (await messages(thread)).filter((message) => message.card?.requestId === id);
    const bot = (await api("POST", "/api/bots", { name: "Approvals sweep", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    const dump = join(dataDir, "fake-claude-dump.json");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold this task while approvals are exercised." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    const socketPath = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.dog.args.at(-1) as string;

    const ask = async (command: string, id: string = randomUUID()) => {
      const socket = connect(socketPath);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      let answer: any;
      let buffer = "";
      const reply = new Promise<any>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("close", () => reject(new Error(`socket closed before a reply to ${id}`)));
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (!buffer.includes("\n")) return;
          answer = JSON.parse(buffer.split("\n")[0]!);
          resolve(answer);
        });
      });
      void reply.catch(() => {});
      socket.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command } }) + "\n");
      return { id, reply, answer: () => answer };
    };
    const respond = (requestId: string, behavior: "allow" | "deny") =>
      api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior });

    const first = await ask("printf first");
    await expect.poll(async () => (await cards(bot.threadId, first.id)).length).toBe(1);
    const echo = await ask("printf first", first.id);
    expect(await echo.reply).toMatchObject({ id: first.id, behavior: "deny" });
    await delay(2_500);
    expect(first.answer()).toBeUndefined();
    expect(await cards(bot.threadId, first.id)).toHaveLength(1);

    expect((await respond(first.id, "allow")).outcome).toBe("allowed-once");
    expect(await first.reply).toMatchObject({ id: first.id, behavior: "allow" });
    expect((await respond(first.id, "allow")).outcome).toBe("unavailable");
    expect((await cards(bot.threadId, first.id))[0].card.answered).toBe("allow");

    const second = await ask("printf second");
    await expect.poll(async () => (await cards(bot.threadId, second.id)).length).toBe(1);
    expect((await respond(second.id, "deny")).outcome).not.toBe("unavailable");
    expect(await second.reply).toMatchObject({ id: second.id, behavior: "deny" });

    const third = await ask("printf third");
    await expect.poll(async () => (await cards(bot.threadId, third.id)).length).toBe(1);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(await third.reply).toMatchObject({ id: third.id, behavior: "deny" });

    const decisions = (await api("GET", "/api/decisions")).decisions as Array<{ requestId?: string; decision?: string }>;
    const approvals = decisions.filter((row) => row.decision === "user-approved").map((row) => row.requestId);
    expect(approvals).toEqual([first.id]);
  }, 90_000);
});

describe("error messages", () => {
  it("are plain sentences: no stack, no errno, no path, no validation report, no byte counts", async () => {
    const fixture = await launchVerificationServer();
    cleanups.push(() => fixture.close());
    const { url } = fixture.info;
    const api = client(url);
    const bot = (await api("POST", "/api/bots", { name: "Honest errors" }, 201)).bot;
    const attempts: Array<[string, string, unknown, number]> = [
      ["POST", "/api/bots/nope/messages", { text: "hi" }, 404],
      ["POST", `/api/bots/${bot.id}/messages`, { text: "", threadId: bot.threadId }, 400],
      ["POST", `/api/bots/${bot.id}/messages`, { text: "x", threadId: "no-such-thread" }, 409],
      ["GET", "/api/threads/nope/messages", undefined, 404],
      ["POST", "/api/threads/nope/respond", { requestId: "r", behavior: "allow" }, 404],
      ["POST", `/api/threads/${bot.threadId}/respond`, { requestId: "r", behavior: "maybe" }, 400],
      ["PATCH", `/api/bots/${bot.id}`, { name: 5 }, 400],
      ["POST", "/api/bots", { name: ["x"] }, 400],
      ["DELETE", "/api/bots/nope", undefined, 404],
      ["POST", "/api/attachments", undefined, 400],
      ["DELETE", `/api/bots/${bot.id}/queue/nope`, { threadId: bot.threadId }, 404],
      ["POST", "/api/groups", { name: "" }, 400],
    ];
    const raw = /\n\s+at\s|\bE(?:NOENT|ACCES|NOSPC|PERM|BUSY|XIST)\b|\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\|SQLITE|TypeError|undefined|\[object Object\]|"code":|\bthe user\b|\d{6,} bytes/;
    const seen: string[] = [];
    for (const [method, path, body, status] of attempts) {
      const response = await fetch(url + path, {
        method, headers: { origin: url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json() as { error?: string };
      expect(response.status, `${method} ${path}`).toBe(status);
      expect(typeof result.error, `${method} ${path}`).toBe("string");
      expect(result.error, `${method} ${path}`).not.toMatch(raw);
      expect(result.error!.length, `${method} ${path}`).toBeGreaterThan(5);
      seen.push(result.error!);
    }
    expect(seen).toContain("That wasn't something later.dog could use (name: Invalid input: expected string, received array). Check it and try again.");
  }, 60_000);

  it("state a size limit in megabytes", async () => {
    const fixture = await launchVerificationServer();
    cleanups.push(() => fixture.close());
    const { url } = fixture.info;
    const upload = (path: string, declared: number, type: string) => new Promise<{ status: number; error: string }>((resolve, reject) => {
      const outgoing = request(url + path, { method: "POST", headers: { origin: url, "content-length": String(declared), "content-type": type } }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => { resolve({ status: response.statusCode ?? 0, error: JSON.parse(text).error }); outgoing.destroy(); });
      });
      outgoing.on("error", reject);
      outgoing.write("x");
    });
    expect(await upload("/api/files?name=big.bin", 30 * 1024 * 1024, "application/octet-stream")).toEqual({
      status: 413, error: "That file is bigger than 25 MB, which is the most later.dog takes. Try a smaller one.",
    });
    expect(await upload("/api/attachments", 12 * 1024 * 1024, "image/png")).toEqual({
      status: 413, error: "That picture is bigger than 10 MB, which is the most later.dog takes. Try a smaller one.",
    });
  }, 60_000);
});
