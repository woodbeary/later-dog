// later.dog's rule (server/laterdog/dog-creation.ts): any dog the person can see creates a dog when asked, the way the
// reference product's bots do. This drives an ordinary dog's real turn in a disposable server with the fake engine: the
// agents proxy that turn mounts lists create_bot, its tools/call creates "Scout" through /api/internal/create-bot, and
// Scout lands in the same section with the safe defaults, already greeting the person in its own chat. The per-turn cap,
// the duplicate check and the archived-dog refusal still hold.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { z } from "zod";

import { launchVerificationServer } from "../../scripts/control-laterdog.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";

type Bot = { id: string; threadId: string; name: string };
type Mounted = { command: string; args: string[]; env: Record<string, string> };
type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

const CHIEF_ONLY_TOOLS = ["list_team_setup", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread"];
const dumpSchema = z.object({
  systemPrompt: z.string(),
  mcpConfig: z.object({ mcpServers: z.object({
    agents: z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
  }) }),
});

it("lets an ordinary dog create a dog that greets the person, within the per-turn cap; an archived dog cannot", async () => {
  const temp = mkdtempSync(join(tmpdir(), "laterdog-dog-creation-"));
  const gate = join(temp, "finish");
  // A slow turn holds until the gate exists, so each dog's turn (and its capability) stays live while it is checked.
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const proxies: ChildProcess[] = [];
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const bots = async () => (await api("GET", "/api/bots?messages=0")).bots as Array<Record<string, any>>;
  // What one dog's turn mounts: its agents proxy, spawned the way the engine spawns it.
  const startTurn = async (bot: Bot, text: string) => {
    rmSync(fixture.fixtureDumpPath, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { text }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = dumpSchema.parse(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    const mounted: Mounted = dump.mcpConfig.mcpServers.agents;
    expect(mounted.env.LATERDOG_BOT_ID).toBe(bot.id);
    expect(mounted.env.LATERDOG_CHIEF_OF_STAFF).toBe("0");
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
    return { token: mounted.env.LATERDOG_COMMS_TOKEN!, systemPrompt: dump.systemPrompt, tool, toolNames };
  };

  try {
    await api("PUT", "/api/config", { profile: { name: "Jacob" } });
    const biscuit: Bot = (await api("POST", "/api/bots", { name: "Biscuit", section: "Research" }, 201)).bot;
    const rex: Bot = (await api("POST", "/api/bots", { name: "Rex", section: "Research" }, 201)).bot;
    expect((await bots()).filter((bot) => bot.chiefOfStaff)).toEqual([]);

    // An ordinary dog's turn is shown create_bot, and none of the tools only a Chief keeps.
    const turn = await startTurn(biscuit, "can u make another agent");
    const tools = await turn.toolNames();
    evidence.push({ biscuitTools: tools });
    expect(tools).toContain("create_bot");
    expect(CHIEF_ONLY_TOOLS.filter((name) => tools.includes(name))).toEqual([]);
    // Its instructions say it may create one itself, not that only a Chief can.
    expect(turn.systemPrompt).toContain("create_bot");
    expect(turn.systemPrompt).not.toMatch(/bot-creation and team-setup tools for Chiefs|only the section's Chief of Staff creates bots|create bots unless you are a Chief/);

    const created = await turn.tool("create_bot", {
      name: "Scout",
      role: "research and writing",
      instructions: "Find sources, read them closely and draft short summaries with links.",
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const said = created.content.map((item) => item.text).join("\n");
    expect(said).toMatch(/^Created @Scout in Research \[id: [\w-]+\]\./);
    expect(said).toContain("sidebar");

    const scout = (await bots()).find((bot) => bot.name === "Scout")!;
    expect(scout).toMatchObject({
      section: "Research", title: "research and writing",
      description: "Find sources, read them closely and draft short summaries with links.",
      composio: false, connectorTools: {}, autoApprove: false, approvePeerComms: false, unread: true,
    });
    expect(scout.chiefOfStaff).toBeFalsy();
    expect(scout.visibility).toBeUndefined();
    expect(said).toContain(`[id: ${scout.id}]`);
    // Its own chat opens with its greeting to the person, naming who set it up.
    const greeting = (await api("GET", `/api/threads/${scout.threadId}/messages`)).messages as Array<Record<string, unknown>>;
    evidence.push({ greeting });
    expect(greeting).toHaveLength(1);
    expect(greeting[0]).toMatchObject({
      role: "bot", kind: "text",
      text: "Hi Jacob, I'm Scout. Biscuit set me up for research and writing. What should I start on?",
    });

    // The other guards are unchanged: no duplicate name in the section, and four new dogs per turn.
    const create = (name: string, expected: number) => api("POST", "/api/internal/create-bot",
      { name, role: "research and writing", instructions: "Help with research." }, expected, turn.token);
    expect((await create("scout", 409)).error).toContain("@Scout already exists in this section");
    for (const name of ["Scout Two", "Scout Three", "Scout Four"]) await create(name, 201);
    expect((await create("Scout Five", 429)).error).toContain("at most 4 bots in one turn");
    const research = (await bots()).filter((bot) => bot.section === "Research").map((bot) => bot.name).sort();
    expect(research).toEqual(["Biscuit", "Rex", "Scout", "Scout Four", "Scout Three", "Scout Two"]);

    // An archived dog is refused in plain words, and nothing is created.
    const archived = await startTurn(rex, "make me a helper");
    expect(await archived.toolNames()).toContain("create_bot");
    await api("PATCH", `/api/bots/${rex.id}`, { hidden: true });
    const refused = await archived.tool("create_bot", { name: "Shadow", role: "keeping watch", instructions: "Watch." });
    expect(refused.isError).toBe(true);
    expect(refused.content.map((item) => item.text).join("\n")).toBe("This bot is archived, so it cannot create bots. Ask the person to restore it first.");
    expect((await bots()).some((bot) => bot.name === "Shadow")).toBe(false);
  } finally {
    writeFileSync(gate, "finish");
    for (const proxy of proxies) await waitForExit(proxy, { signal: "SIGTERM" });
    await fixture.close();
    await removeTempDir(temp);
    writeFileSync(`${fixture.info.logPath}.dog-creation.json`, JSON.stringify(evidence, null, 2));
  }
}, 90_000);
