import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";

const OWNER = "o".repeat(43);
const TOOLS = "t".repeat(43);

it("lets the scripts work on a packaged-style desktop with only the local tools token, and keeps everything a dog could abuse refused", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-laterdog-desktop-owner": OWNER } });
  const fixture = await launchVerificationServer({
    ...process.env, FAKE_CLAUDE_MODE: "hang", LATERDOG_TEST_DESKTOP_OWNER_TOKEN: OWNER, LATERDOG_TEST_LOCAL_TOOLS_TOKEN: TOOLS,
  }).finally(() => { globalThis.fetch = realFetch; });
  const dir = mkdtempSync(join(tmpdir(), "laterdog-local-tools-e2e-"));
  const tokenFile = join(dir, "local-control-token");
  writeFileSync(tokenFile, `${TOOLS}\n`, { mode: 0o600 });
  const url = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const tools = { "x-laterdog-local-tools": TOOLS };
  const owner = { "x-laterdog-desktop-owner": OWNER };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url], { env: { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: tokenFile } }) as Promise<any>;
  let socket: Socket | undefined;
  console.log(`local tools token fixture: ${fixture.info.logPath}`);
  try {
    await expect.poll(async () => (await api("POST", "/api/bots", { name: "Probe" })).status, { timeout: 10_000 }).toBe(403);
    const noToken = await api("POST", "/api/bots", { name: "Probe" });
    expect(noToken.body.error).toBe("forbidden: this change must come from the desktop app or a paired device");
    expect((await api("GET", "/api/bots?messages=0")).status).toBe(200);

    const made = (await cli("new-bot", "--name", "Scripted", "--title", "Scripted dog")).bot;
    const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
    const state = async () => (await bots()).find((candidate) => candidate.id === made.id);
    expect(await state()).toMatchObject({ name: "Scripted", title: "Scripted dog" });
    expect(await state()).not.toMatchObject({ approvalMode: "auto" });
    expect(await state()).not.toMatchObject({ approvalMode: "full" });
    expect((await state()).autoApprove).not.toBe(true);
    const threadId = made.activeTaskId as string;
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;

    expect((await cli("doctor")).ok).toBe(true);
    expect((await cli("bots")).bots.some((candidate: any) => candidate.id === made.id)).toBe(true);
    const channel = (await cli("new-channel", "--name", "Scripted room", "--members", made.id)).channel;
    expect(channel.name).toBe("Scripted room");
    await cli("send-channel", "--channel", channel.id, "--text", "hello room");
    await cli("interrupt", "--channel", channel.id);
    await expect.poll(async () => Boolean(((await api("GET", "/api/bots?messages=0")).body.groups as any[]).find((group) => group.id === channel.id)?.working), { timeout: 15_000 }).toBe(false);

    await cli("send", "--bot", made.id, "--text", "work for a while");
    await expect.poll(async () => (await messages()).find((message) => message.text === "work for a while")?.via, { timeout: 15_000 }).toBe("api");
    expect((await cli("messages", "--bot", made.id)).messages.some((message: any) => message.text === "work for a while")).toBe(true);
    await expect.poll(async () => Boolean((await state())?.busy), { timeout: 15_000 }).toBe(true);

    for (const [method, path, body] of [
      ["POST", `/api/bots/${made.id}/respond`, { threadId, requestId: "r", behavior: "allow" }],
      ["PATCH", `/api/bots/${made.id}/tasks/${threadId}`, { surface: "local" }],
      ["PATCH", `/api/bots/${made.id}/tasks/${threadId}`, { approvalMode: "auto" }],
      ["PATCH", `/api/bots/${made.id}`, { connectorTools: { gmail: "write" } }],
      ["PATCH", `/api/bots/${made.id}`, { cloudBackend: "vps", autoStartVps: true, browserProfile: "p", visibility: "everyone" }],
      ["PATCH", `/api/bots/${made.id}`, { fallback: [{ instanceId: "claude", model: "m" }] }],
      ["PATCH", `/api/groups/${channel.id}`, { cwd: "/" }],
      ["POST", "/api/bots", { name: "Sneaky", settings: { approvalMode: "full", alwaysAllow: ["Bash"] } }],
      ["POST", "/api/bots", { name: "Sneaky", approvalMode: "auto" }],
      ["POST", "/api/bots/x/computer/exec", { command: "id" }],
      ["POST", "/api/computers/boxes/x/delete", {}],
      ["POST", "/api/keys/test", { provider: "anthropic" }],
      ["PUT", "/api/config", { signIn: { admins: ["someone@example.test"] } }],
      ["PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: "full" } } }],
      ["POST", "/api/live/session", { botId: made.id }],
      ["POST", "/api/laterdog/jobs/j1/action", { action: "merge" }],
      ["POST", `/api/bots/${made.id}/computer/control`, { action: "release" }],
      ["POST", "/api/secure-forms/f1/submit", {}],
      ["DELETE", `/api/bots/${made.id}`, undefined],
    ] as Array<[string, string, unknown]>) {
      const refused = await api(method, path, body, tools);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body.error, `${method} ${path}`).toMatch(/approve its own work/);
    }
    expect((await api("GET", "/api/desktop-viewer/session", undefined, tools)).status).toBe(403);
    expect((await state())).toBeTruthy();
    expect((await api("POST", `/api/bots/${made.id}/messages`, { text: "again", threadId }, { "x-laterdog-local-tools": "s".repeat(43) })).status).toBe(403);

    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.dog?.args[1]; } catch { return undefined; }
    }, { timeout: 10_000 }).toEqual(expect.any(String));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    socket = connect(dump.mcpConfig.mcpServers.dog.args[1]);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
    const requestId = randomUUID();
    socket.write(JSON.stringify({
      t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion",
      input: { questions: [{ question: "Which file should I update?", options: [{ label: "README" }, { label: "Guide" }] }] },
    }) + "\n");
    await expect.poll(async () => (await messages()).find((message) => message.card?.requestId === requestId), { timeout: 10_000 }).toBeTruthy();
    const card = async () => (await messages()).find((message) => message.card?.requestId === requestId)!.card;

    const typedByTools = await api("POST", `/api/bots/${made.id}/messages`, { text: "README", threadId }, tools);
    expect(typedByTools.status).toBe(202);
    expect((await card()).answered).toBeUndefined();
    expect((await card()).answeredBy).toBeUndefined();
    const sentByScript = await cli("send", "--bot", made.id, "--text", "Guide");
    expect(sentByScript.success).toBe(true);
    expect((await card()).answered).toBeUndefined();

    const typedByDesktop = await api("POST", `/api/bots/${made.id}/messages`, { text: "Guide", threadId }, owner);
    expect(typedByDesktop.status).toBe(202);
    await expect.poll(async () => (await card()).answered, { timeout: 10_000 }).toBe("answer");
    expect((await card()).answeredBy).toMatchObject({ kind: "loopback" });
    expect((await state()).busy).toBe(true);

    await cli("interrupt", "--bot", made.id);
    await expect.poll(async () => Boolean((await state())?.busy), { timeout: 15_000 }).toBe(false);
    const model = (await cli("models")).instances.find((instance: any) => instance.snapshot?.state === "available");
    const set = await cli("set-model", "--bot", made.id, "--instance", model.instanceId, "--model", model.models.default);
    expect(set.success).toBe(true);
  } finally {
    socket?.destroy();
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
