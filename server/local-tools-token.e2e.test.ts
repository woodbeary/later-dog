import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { EDIT_REFUSAL } from "./laterdog/local-tool-message.ts";
import { waitForExit } from "./testing/cleanup.ts";

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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP_PARENT = pathToFileURL(join(ROOT, "server", "testing", "desktop-parent.mjs")).href;
const TOKENS = { LATERDOG_TEST_DESKTOP_OWNER_TOKEN: OWNER, LATERDOG_TEST_LOCAL_TOOLS_TOKEN: TOOLS };
const toolsHeader = { "x-laterdog-local-tools": TOOLS };
const ownerHeader = { "x-laterdog-desktop-owner": OWNER };

async function desktopFixture(parentEnv: NodeJS.ProcessEnv, scripted = false) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), ...ownerHeader } });
  const fixture = await launchVerificationServer({ ...process.env, ...parentEnv, ...TOKENS }, undefined, undefined, undefined, undefined, scripted ? { scripted: true } : undefined)
    .finally(() => { globalThis.fetch = realFetch; });
  const url = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  let restarted: ChildProcess | undefined;
  const restart = async () => {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    return async () => {
      const env = verificationServerEnvironment({ ...process.env, ...parentEnv, ...TOKENS }, fixture.info.dataDir, Number(new URL(url).port));
      const log = openSync(fixture.info.logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", "--import", DESKTOP_PARENT, join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdio: ["ignore", log, log] });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await api("POST", "/api/bots/none/messages", { text: "x" }, toolsHeader)).status, { timeout: 10_000 }).toBe(404);
    };
  };
  const close = async () => {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  };
  return { fixture, url, api, restart, close, dataDir: fixture.info.dataDir };
}

const readPrompts = (file: string): string[] => existsSync(file)
  ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.stringify(JSON.parse(line))) : [];

it("lets a local tool on the owner's Mac reach every dog as the owner, edits only its own messages, and keeps it out of packs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-local-tools-reach-"));
  const promptsFile = join(dir, "prompts.jsonl");
  const tokenFile = join(dir, "local-control-token");
  writeFileSync(tokenFile, `${TOOLS}\n`, { mode: 0o600 });
  const desktop = await desktopFixture({ FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: promptsFile });
  const { api, url, dataDir } = desktop;
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url], { env: { LATERDOG_LOCAL_CONTROL_TOKEN_FILE: tokenFile } }) as Promise<any>;
  const made = async (name: string) => (await api("POST", "/api/bots", { name }, ownerHeader)).body.bot;
  const room = async (name: string, memberIds: string[]) =>
    (await api("POST", "/api/groups", { name, memberIds, setup: { bulletin: "", defaultResponder: { kind: "everyone" } } }, ownerHeader)).body.group;
  try {
    const guarded = await made("Guarded");
    const heel = await made("Heel");
    const unguarded = await made("Unguarded");
    expect((await api("PATCH", `/api/bots/${heel.id}`, { approvalMode: "ask" }, ownerHeader)).status).toBe(200);
    const safe = await room("Safe room", [guarded.id, heel.id]);
    const unsafe = await room("Unsafe room", [guarded.id, unguarded.id]);
    const startAgain = await desktop.restart();
    const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const target = saved.find((bot: any) => bot.id === unguarded.id);
    target.approvalMode = "full"; target.autoApprove = false;
    for (const task of target.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved, null, 2));
    await startAgain();

    const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
    const idle = (id: string) => expect.poll(async () => Boolean((await bots()).find((bot) => bot.id === id)?.busy), { timeout: 20_000 }).toBe(false);
    const messagesOf = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;
    expect((await bots()).find((bot) => bot.id === unguarded.id)).toMatchObject({ approvalMode: "full" });

    const refusal = (result: { status: number; body: any }, text: string) => { expect(result.status).toBe(403); expect(result.body.error).toBe(text); };
    for (const path of ["/api/bots", "/api/groups"]) {
      const body = path === "/api/bots" ? { name: "Pack dog", section: "Ops" } : { name: "Pack room", memberIds: [guarded.id], section: "Ops" };
      const refused = await api("POST", path, body, toolsHeader);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/approve its own work/);
    }
    await expect(cli("new-bot", "--name", "Pack dog", "--section", "Ops")).rejects.toThrow(/approve its own work/);
    await expect(cli("new-channel", "--name", "Pack room", "--members", guarded.id, "--section", "Ops")).rejects.toThrow(/approve its own work/);
    expect((await cli("new-bot", "--name", "Plain dog")).success).toBe(true);

    expect((await api("POST", `/api/bots/${unguarded.id}/messages`, { text: "go", threadId: unguarded.threadId }, toolsHeader)).status).toBe(202);
    await idle(unguarded.id);
    const gathered = await api("POST", "/api/groups", { name: "Gathered", memberIds: [guarded.id, unguarded.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } }, toolsHeader);
    expect(gathered.status, JSON.stringify(gathered.body)).toBe(201);
    expect((await api("PATCH", `/api/groups/${safe.id}`, { memberIds: [guarded.id, heel.id, unguarded.id] }, toolsHeader)).status).toBe(200);
    expect((await cli("send", "--bot", unguarded.id, "--text", "go again")).success).toBe(true);
    await idle(unguarded.id);

    expect((await api("POST", `/api/bots/${guarded.id}/messages`, { text: "run the tests", threadId: guarded.threadId }, toolsHeader)).status).toBe(202);
    await expect.poll(() => readPrompts(promptsFile).some((prompt) => prompt.includes("run the tests")), { timeout: 20_000 }).toBe(true);
    const delivered = readPrompts(promptsFile).filter((prompt) => prompt.includes("run the tests")).at(-1)!;
    expect(delivered).not.toContain("Message from a local tool");
    expect(delivered).not.toContain("not typed by");
    await idle(guarded.id);
    expect((await api("POST", `/api/groups/${unsafe.id}/messages`, { text: "room tool message", threadId: unsafe.threadId }, toolsHeader)).status).toBe(202);
    await expect.poll(() => readPrompts(promptsFile).some((prompt) => prompt.includes(": room tool message")), { timeout: 20_000 }).toBe(true);
    expect(readPrompts(promptsFile).some((prompt) => prompt.includes("A local tool on this Mac"))).toBe(false);
    await expect.poll(async () => Boolean(((await api("GET", "/api/bots?messages=0")).body.groups as any[]).find((group) => group.id === unsafe.id)?.working), { timeout: 20_000 }).toBe(false);

    await idle(guarded.id);
    await api("POST", `/api/bots/${guarded.id}/messages`, { text: "mine", threadId: guarded.threadId }, ownerHeader);
    await idle(guarded.id);
    await api("POST", `/api/bots/${guarded.id}/messages`, { text: "tool one", threadId: guarded.threadId }, toolsHeader);
    await idle(guarded.id);
    const thread = await messagesOf(guarded.threadId);
    const mine = thread.find((message) => message.role === "user" && message.text === "mine");
    const tools = thread.find((message) => message.role === "user" && message.text === "tool one");
    expect(mine.via).toBeUndefined();
    expect(tools.via).toBe("api");
    refusal(await api("POST", `/api/bots/${guarded.id}/messages/${mine.id}/edit`, { text: "changed by a tool", threadId: guarded.threadId }, toolsHeader), EDIT_REFUSAL);
    expect((await messagesOf(guarded.threadId)).some((message) => message.text === "changed by a tool")).toBe(false);
    expect((await api("POST", `/api/bots/${guarded.id}/messages/${tools.id}/edit`, { text: "tool two", threadId: guarded.threadId }, toolsHeader)).status).toBe(202);
    await idle(guarded.id);
    expect((await messagesOf(guarded.threadId)).find((message) => message.role === "user" && message.text === "tool two")?.via).toBe("api");
    expect((await api("POST", `/api/bots/${guarded.id}/messages/${mine.id}/edit`, { text: "mine, edited", threadId: guarded.threadId }, ownerHeader)).status).toBe(202);
  } finally {
    await desktop.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

it("records a stop from a local tool as the tool's, not the person's, while the person's stop still says so", async () => {
  const desktop = await desktopFixture({ FAKE_CLAUDE_MODE: "happy" }, true);
  const { api, dataDir } = desktop;
  const planPath = join(dataDir, "room-plan.json");
  const nodes = (): any[] => existsSync(join(dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) : [];
  const plan: Record<string, any> = {};
  const pair = async (label: string) => {
    const chief = (await api("POST", "/api/bots", { name: `Chief ${label}`, section: "Leadership" }, ownerHeader)).body.bot;
    const lead = (await api("POST", "/api/bots", { name: `Lead ${label}`, section: "Engineering" }, ownerHeader)).body.bot;
    expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, ownerHeader)).status).toBe(200);
    plan[chief.id] = { steps: [{ arguments: { bot_ids: [lead.id], message: `Build ${label}` } }], reply: "Assigned", resumeReply: "Done" };
    plan[lead.id] = { delayMs: 6000, reply: `Lead ${label} finished` };
    writeFileSync(planPath, JSON.stringify(plan));
    return { chief, lead };
  };
  try {
    const byTool = await pair("one");
    expect((await api("POST", `/api/bots/${byTool.chief.id}/messages`, { text: "Please have Engineering build one", threadId: byTool.chief.threadId }, toolsHeader)).status).toBe(202);
    await expect.poll(() => nodes().find((node) => node.botId === byTool.lead.id)?.status, { timeout: 20_000 }).toBe("running");
    expect((await api("POST", `/api/bots/${byTool.chief.id}/interrupt`, { threadId: byTool.chief.threadId }, toolsHeader)).status).toBe(200);
    await expect.poll(() => nodes().find((node) => !node.parentId && node.botId === byTool.chief.id)?.status, { timeout: 20_000 }).toBe("cancelled");
    const stopped = nodes().find((node) => !node.parentId && node.botId === byTool.chief.id);
    expect(stopped).toMatchObject({ endedBy: "api", result: "A local tool on this Mac stopped this work." });
    expect(JSON.stringify(nodes().filter((node) => node.botId === byTool.chief.id))).not.toMatch(/person stopped|stopped by the person/i);

    const byPerson = await pair("two");
    expect((await api("POST", `/api/bots/${byPerson.chief.id}/messages`, { text: "Please have Engineering build two", threadId: byPerson.chief.threadId }, ownerHeader)).status).toBe(202);
    await expect.poll(() => nodes().find((node) => node.botId === byPerson.lead.id)?.status, { timeout: 20_000 }).toBe("running");
    expect((await api("POST", `/api/bots/${byPerson.chief.id}/interrupt`, { threadId: byPerson.chief.threadId }, ownerHeader)).status).toBe(200);
    await expect.poll(() => nodes().find((node) => !node.parentId && node.botId === byPerson.chief.id)?.status, { timeout: 20_000 }).toBe("cancelled");
    expect(nodes().find((node) => !node.parentId && node.botId === byPerson.chief.id)).toMatchObject({ endedBy: "person", result: "The person stopped this work." });
  } finally {
    await desktop.close();
  }
}, 120_000);
