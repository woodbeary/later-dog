import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-laterdog.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("a dog creates dogs with the workspace default or a validated explicit model, never more access than its own, and no per-turn cap in the owner's workspace", async () => {
  const temp = mkdtempSync(join(tmpdir(), "laterdog-create-model-"));
  const gate = join(temp, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  try {
    const instances = (await api("GET", "/api/instances")).instances;
    const claude = instances.find((item: any) => item.instanceId === "claude");
    const codex = instances.find((item: any) => item.instanceId === "codex");
    const defaultModel = { instanceId: "codex", model: codex.models.default, effort: "low" };
    await api("PATCH", "/api/config", { defaultModelSelection: defaultModel });
    const makerModel = { instanceId: "claude", model: claude.models.default };
    const maker = (await api("POST", "/api/bots", { name: "Main dog", section: "Design", modelSelection: makerModel }, 201)).bot;
    await api("PATCH", "/api/main-dog", { botId: maker.id });
    await api("POST", `/api/bots/${maker.id}/messages`, { text: "Prepare a specialist." }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    let token = dump.mcpConfig.mcpServers.agents.env.LATERDOG_COMMS_TOKEN;
    const create = (name: string, modelSelection?: unknown, expected = 201) => api("POST", "/api/internal/create-bot", {
      fromBotId: maker.id, fromThreadId: maker.threadId, name,
      role: "Specialist", instructions: "Complete assigned work.",
      ...(modelSelection === undefined ? {} : { modelSelection }),
    }, expected, token);
    const first = await create("Default specialist");
    expect(first.modelSelection).toEqual(defaultModel);
    const explicit = { instanceId: "claude", model: claude.models.options.find((item: any) => item.id !== claude.models.default).id, effort: "low" };
    const second = await create("Chosen specialist", explicit);
    expect(second.modelSelection).toEqual(explicit);
    const bots = (await api("GET", "/api/bots")).bots;
    expect(bots.find((bot: any) => bot.id === maker.id).modelSelection).toEqual(makerModel);
    for (const [id, modelSelection] of [[first.id, defaultModel], [second.id, explicit]]) {
      expect(bots.find((bot: any) => bot.id === id)).toMatchObject({
        section: "Design", modelSelection, approvalMode: "ask", autoApprove: false, approvePeerComms: false,
      });
      expect(bots.find((bot: any) => bot.id === id).composio).toBe(bots.find((bot: any) => bot.id === maker.id).composio);
    }
    for (const invalid of [null, {}, { instanceId: "missing", model: "missing" },
      { ...explicit, model: "not-in-catalog" }, { ...explicit, effort: "invalid" },
      { ...explicit, variant: "a-variant" }]) {
      await create("Invalid specialist", invalid, 400);
    }
    expect((await api("GET", "/api/bots")).bots.length).toBe(bots.length);
    for (const name of ["Third specialist", "Fourth specialist", "Fifth specialist", "Sixth specialist"]) await create(name);
    expect((await api("GET", "/api/bots")).bots.length).toBe(bots.length + 4);
    writeFileSync(gate, "finish");
    await expect.poll(async () => !(await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === maker.id).busy, { timeout: 20_000 }).toBe(true);
    await create("Expired authority", undefined, 401);
    await api("PATCH", "/api/config", { defaultModelSelection: explicit });
    unlinkSync(gate);
    unlinkSync(fixture.fixtureDumpPath);
    await api("POST", `/api/bots/${maker.id}/messages`, { text: "Prepare the next specialist." }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.LATERDOG_COMMS_TOKEN;
    expect((await create("Updated default specialist")).modelSelection).toEqual(explicit);
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === first.id).modelSelection).toEqual(defaultModel);
  } finally {
    writeFileSync(gate, "finish");
    await fixture.close();
    await removeTempDir(temp);
  }
}, 60_000);
