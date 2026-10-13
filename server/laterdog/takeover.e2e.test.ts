import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { z } from "zod";

import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { TAKEOVER_PROMPT } from "./takeover.ts";

type Bot = { id: string; threadId: string; name: string; computer?: string | null };
type Mounted = { command: string; args: string[]; env: Record<string, string> };
type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type Message = Record<string, any>;

const dumpSchema = z.object({
  systemPrompt: z.string(),
  mcpConfig: z.object({ mcpServers: z.object({
    agents: z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
  }) }),
});

const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

it("hands one step to the person, waits while they hold the screen, and picks the task back up on its own", async () => {
  const temp = mkdtempSync(join(tmpdir(), "laterdog-takeover-"));
  const gate = join(temp, "finish");
  const promptsLog = join(temp, "prompts.jsonl");
  const boatCalls: string[] = [];
  const boat = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    boatCalls.push(`${req.method} ${path}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "GET" && path === "/boxes" ? { boxes: [] } : {}));
  });
  await new Promise<void>((resolve) => boat.listen(0, "127.0.0.1", resolve));
  const address = boat.address();
  if (!address || typeof address === "string") throw new Error("the cloud computer fixture did not bind");
  const fixture = await launchVerificationServer(
    { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_PROMPTS: promptsLog },
    undefined, undefined, undefined, undefined, undefined, [], `http://127.0.0.1:${address.port}`,
  ).catch(async (error) => {
    boat.closeAllConnections();
    await new Promise<void>((resolve) => boat.close(() => resolve()));
    throw error;
  });
  const proxies: ChildProcess[] = [];
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200, headers: Record<string, string> = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const bots = async () => (await api("GET", "/api/bots?messages=0")).bots as Array<Record<string, any>>;
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`)).messages as Message[];
  const cards = async (threadId: string) => (await messages(threadId)).filter((message) => message.card?.takeoverRequest);
  const control = (bot: Bot) => api("GET", `/api/bots/${bot.id}/computer/control`);
  const prompts = () => existsSync(promptsLog)
    ? readFileSync(promptsLog, "utf8").split("\n").filter(Boolean).map((line) => strings(JSON.parse(line)).join("\n"))
    : [];
  const said = (result: ToolResult) => result.content.map((item) => item.text).join("\n");
  const settled = async (bot: Bot, threadId: string, reply: string) => {
    await expect.poll(async () => (await messages(threadId)).some((message) =>
      message.role === "bot" && message.kind === "text" && String(message.text ?? "").includes(reply)), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await bots()).find((entry) => entry.id === bot.id)?.busy, { timeout: 20_000 }).toBe(false);
  };
  const operatorWait = (bot: Bot, threadId: string) =>
    runControlLaterDog(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "5", "--url", fixture.info.url]) as Promise<any>;
  const startTurn = async (bot: Bot, text: string) => {
    rmSync(gate, { force: true });
    rmSync(fixture.fixtureDumpPath, { force: true });
    const receipt = await api("POST", `/api/bots/${bot.id}/messages`, { text }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = dumpSchema.parse(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    const mounted: Mounted = dump.mcpConfig.mcpServers.agents;
    expect(mounted.env.LATERDOG_BOT_ID).toBe(bot.id);
    const proxy = spawn(mounted.command, mounted.args, {
      env: { ...mounted.env, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proxies.push(proxy);
    const pending = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>();
    let nextId = 0;
    createInterface({ input: proxy.stdout! }).on("line", (line) => {
      const reply = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
      pending.get(reply.id)?.(reply);
    });
    const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<{ result?: any; error?: any }>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer`)); }, 10_000);
      pending.set(id, (reply) => { clearTimeout(timer); pending.delete(id); resolve(reply); });
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const tool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const reply = await rpc("tools/call", { name, arguments: args });
      evidence.push({ bot: bot.name, tool: name, args, reply });
      expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
      return reply.result as ToolResult;
    };
    const toolNames = async () => ((await rpc("tools/list")).result.tools as Array<{ name: string }>).map((entry) => entry.name);
    return { threadId: String(receipt.threadId), systemPrompt: dump.systemPrompt, tool, toolNames, finish: () => writeFileSync(gate, "finish") };
  };

  try {
    await api("PUT", "/api/config", { profile: { name: "Jacob" } });
    const pepper: Bot = (await api("POST", "/api/bots", { name: "Pepper" }, 201)).bot;
    await api("PATCH", `/api/bots/${pepper.id}`, { computer: "cloud" });

    const shop = await startTurn(pepper, "Order my usual groceries from Tesco");
    expect(shop.systemPrompt).toContain(TAKEOVER_PROMPT.trim());
    expect(await shop.toolNames()).toContain("request_takeover");
    const first = await shop.tool("request_takeover", { step: "Sign in", reason: "sign-in" });
    expect(first.isError, said(first)).toBeFalsy();
    const asked = await shop.tool("request_takeover", { step: "Sign in to Tesco", reason: "sign-in" });
    expect(said(asked)).toContain("\"Sign in to Tesco\"");
    expect(said(asked)).toMatch(/End this turn now/);
    expect(said(asked)).toMatch(/Never ask for passwords or codes in chat/);
    const [signIn, ...extra] = await cards(shop.threadId);
    expect(extra).toEqual([]);
    expect(signIn).toMatchObject({ role: "bot", kind: "options", card: {
      title: "Sign in to Tesco",
      takeoverRequest: { step: "Sign in to Tesco", reason: "sign-in", status: "waiting", place: "cloud" },
    } });
    expect(await control(pepper)).toMatchObject({ held: false, helpReason: "Sign in to Tesco" });

    shop.finish();
    await settled(pepper, shop.threadId, "reply to: Order my usual groceries from Tesco");
    expect((await operatorWait(pepper, shop.threadId)).status).toBe("needs-user");

    expect(await api("POST", `/api/bots/${pepper.id}/takeover-cards/${signIn.id}/take`, { threadId: shop.threadId })).toEqual({ status: "in-control" });
    expect(await control(pepper)).toMatchObject({ held: true });
    expect((await cards(shop.threadId))[0].card.takeoverRequest.status).toBe("in-control");
    expect(prompts().filter((prompt) => prompt.includes("later.dog computer update"))).toEqual([]);

    await api("POST", `/api/bots/${pepper.id}/computer/control`, { action: "release" });
    await settled(pepper, shop.threadId, "the person handed the screen back after \"Sign in to Tesco\"");
    expect((await cards(shop.threadId))[0].card.takeoverRequest.status).toBe("done");
    expect(await control(pepper)).toMatchObject({ held: false, helpReason: null });
    expect(prompts().filter((prompt) => prompt.includes("handed the screen back after \"Sign in to Tesco\""))).toHaveLength(1);
    expect(prompts().find((prompt) => prompt.includes("handed the screen back"))).toMatch(/Take a fresh screenshot/);
    expect((await messages(shop.threadId)).filter((message) => message.role === "user").map((message) => message.text))
      .toEqual(["Order my usual groceries from Tesco"]);
    await api("POST", `/api/bots/${pepper.id}/takeover-cards/${signIn.id}/take`, { threadId: shop.threadId }, 409);
    expect((await operatorWait(pepper, shop.threadId)).status).toBe("settled");

    const slot = await startTurn(pepper, "Book the Saturday delivery slot");
    await slot.tool("request_takeover", { step: "Pick a delivery slot", reason: "other" });
    const pick = (await cards(slot.threadId)).find((message) => message.card.takeoverRequest.status === "waiting")!;
    expect(pick.id).not.toBe(signIn.id);
    slot.finish();
    await settled(pepper, slot.threadId, "reply to: Book the Saturday delivery slot");
    expect(await api("POST", `/api/bots/${pepper.id}/takeover-cards/${pick.id}/skip`, { threadId: slot.threadId })).toEqual({ status: "skipped" });
    await settled(pepper, slot.threadId, "the person skipped \"Pick a delivery slot\"");
    expect(await control(pepper)).toMatchObject({ held: false, helpReason: null });
    expect(prompts().find((prompt) => prompt.includes("skipped \"Pick a delivery slot\""))).toMatch(/Do not ask for the same step again right away/);

    const opened = await api("POST", "/api/auth/pairing", { label: "Phone fixture", scopes: ["client"] });
    const phone = (await api("POST", "/api/auth/pair", { code: opened.code })).token as string;
    expect(phone).toMatch(/^laterdog_sess_/);
    const checkout = await startTurn(pepper, "Check out the basket");
    await checkout.tool("request_takeover", { step: "Approve the payment", reason: "payment" });
    const pay = (await cards(checkout.threadId)).find((message) => message.card.takeoverRequest.status === "waiting")!;
    checkout.finish();
    await settled(pepper, checkout.threadId, "reply to: Check out the basket");
    await api("POST", `/api/bots/${pepper.id}/messages`, { text: "I already paid on my phone" }, 202, { authorization: `Bearer ${phone}` });
    await settled(pepper, checkout.threadId, "reply to: I already paid on my phone");
    expect((await cards(checkout.threadId)).find((message) => message.id === pay.id)?.card.takeoverRequest.status).toBe("replied");
    expect(await control(pepper)).toMatchObject({ held: false, helpReason: null });
    expect(prompts().filter((prompt) => prompt.includes("\"Approve the payment\""))).toEqual([]);
    await api("POST", `/api/bots/${pepper.id}/takeover-cards/${pay.id}/done`, { threadId: checkout.threadId });
    expect((await cards(checkout.threadId)).find((message) => message.id === pay.id)?.card.takeoverRequest.status).toBe("replied");

    const biscuit: Bot = (await api("POST", "/api/bots", { name: "Biscuit" }, 201)).bot;
    expect(biscuit.computer ?? null).toBeNull();
    const bank = await startTurn(biscuit, "Sign in to my bank and download last month's statement");
    const unplaced = await bank.tool("request_takeover", { step: "Sign in to the bank", reason: "sign-in" });
    expect(unplaced.isError).toBe(true);
    expect(said(unplaced)).toMatch(/select_computer/);
    expect(said(unplaced)).toMatch(/never a reason to refuse/);
    expect(await cards(bank.threadId)).toEqual([]);
    expect(await control(biscuit)).toMatchObject({ helpReason: null });
    bank.finish();
    await settled(biscuit, bank.threadId, "reply to: Sign in to my bank");

    await api("PATCH", `/api/bots/${biscuit.id}`, { computer: "off" });
    const offline = await startTurn(biscuit, "Try the bank again");
    const off = await offline.tool("request_takeover", { step: "Sign in to the bank", reason: "sign-in" });
    expect(off.isError).toBe(true);
    expect(said(off)).toMatch(/switched off/);
    expect(said(off)).not.toMatch(/select_computer/);
    expect(await cards(offline.threadId)).toEqual([]);
    offline.finish();
    await settled(biscuit, offline.threadId, "reply to: Try the bank again");
    evidence.push({ boatCalls, prompts: prompts() });
  } finally {
    writeFileSync(gate, "finish");
    for (const proxy of proxies) await waitForExit(proxy, { signal: "SIGTERM" });
    await fixture.close();
    boat.closeAllConnections();
    await new Promise<void>((resolve) => boat.close(() => resolve()));
    await removeTempDir(temp);
    writeFileSync(`${fixture.info.logPath}.takeover.json`, JSON.stringify(evidence, null, 2));
  }
}, 150_000);
