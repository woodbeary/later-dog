import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const MODEL = "claude-sonnet-5";

it("keeps a team's results waiting while their chat waits for an account, then carries the person's request on and wakes the coordinator once per team", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  let transcript: () => Promise<string[]> = async () => [];
  const outOfUsage = join(dataDir, "accounts-out");
  const plan = join(dataDir, "room-plan.json");
  const files = Object.fromEntries(["askedReady", "askedRelease", "meadowRelease", "orchardRelease"].map(name => [name, join(dataDir, name)]));
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const nodes = (): any[] => existsSync(join(dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) : [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = config.instances.claude.config.cli;
    const limited = { FAKE_CLAUDE_ROOM_PLAN: plan, FAKE_CLAUDE_MODE: "usage-limit", FAKE_CLAUDE_USAGE_LIMIT_GATE: outOfUsage,
      FAKE_CLAUDE_USAGE_RESETS_IN: "20", FAKE_CLAUDE_TOOL_CALLS: "[]" };
    config.instances.claude = { ...config.instances.claude, displayName: "Claude account 1",
      environment: { ...limited, FAKE_CLAUDE_USAGE_LIMIT_ROOM_PLAN: plan, FAKE_CLAUDE_USAGE_LIMIT_AFTER_TOOL: "1" } };
    config.instances["claude-two"] = { driver: "claudeAgent", displayName: "Claude account 2",
      config: { cli, configDir: join(dataDir, "providers", "claude-two") }, environment: limited };
    config.instances.helpers = { driver: "claudeAgent", displayName: "Helpers", access: "api",
      config: { cli, configDir: join(dataDir, "providers", "helpers") },
      environment: { FAKE_CLAUDE_ROOM_PLAN: plan, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_TOOL_CALLS: "[]" } };
    config.accountBattery = { enabled: true, order: { claudeAgent: ["claude", "claude-two"] } };
    writeFileSync(configPath, JSON.stringify(config));
    const out = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", out, out],
    });
    closeSync(out);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const { bot: chief } = await control("new-bot", "--name", "Wait Chief", "--section", "Leadership");
    const { bot: meadow } = await control("new-bot", "--name", "Meadow helper", "--section", "Engineering");
    const { bot: orchard } = await control("new-bot", "--name", "Orchard helper", "--section", "Engineering");
    const threadId = chief.activeTaskId as string;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true });
    await api("PATCH", `/api/bots/${chief.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model: MODEL }, updateBotDefault: true });
    for (const helper of [meadow, orchard]) await api("PATCH", `/api/bots/${helper.id}/tasks/${helper.activeTaskId}`, { modelSelection: { instanceId: "helpers", model: MODEL }, updateBotDefault: true });
    writeFileSync(plan, JSON.stringify({
      [chief.id]: { when: [
        { includes: "carries on now", reply: "CARRIED_ON" },
        { includes: "ORCHARD_DONE", reply: "ORCHARD_SUMMED_UP" },
        { includes: "MEADOW_DONE", reply: "MEADOW_SUMMED_UP" },
        { includes: "SECOND_ASK", steps: [{ arguments: { bot_ids: [orchard.id], request_key: "orchard", message: "ORCHARD_WORK count the orchard" } }], readyFile: files.askedReady, gateFile: files.askedRelease, reply: "Asked Orchard" },
        { includes: "FIRST_ASK", steps: [{ arguments: { bot_ids: [meadow.id], request_key: "meadow", message: "MEADOW_WORK count the meadow" } }], reply: "Asked Meadow" },
      ] },
      [meadow.id]: { when: [{ includes: "MEADOW_WORK", gateFile: files.meadowRelease, reply: "MEADOW_DONE" }] },
      [orchard.id]: { when: [{ includes: "ORCHARD_WORK", gateFile: files.orchardRelease, reply: "ORCHARD_DONE" }] },
    }));
    const rows = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).messages;
    transcript = async () => (await rows()).map(row => `${row.role}/${row.kind}: ${(row.text ?? row.tool?.name ?? "").slice(0, 120)}`);
    const said = async (text: string) => (await rows()).filter(row => row.role === "bot" && row.kind === "text" && row.text === text).length;
    const child = (botId: string) => nodes().find(n => n.botId === botId && n.parentId);
    const rootOf = (botId: string) => nodes().find(n => n.id === child(botId)?.parentId);
    const waiting = async () => Boolean((await api("GET", "/api/config")).accountBattery.waiting[threadId]);

    await control("send", "--bot", chief.id, "--task", threadId, "--text", "FIRST_ASK have Meadow count the meadow");
    await expect.poll(() => child(meadow.id)?.status, { timeout: 30_000 }).toBe("running");
    await expect.poll(() => rootOf(meadow.id)?.status, { timeout: 30_000 }).toBe("waiting");

    writeFileSync(outOfUsage, "out");
    await control("send", "--bot", chief.id, "--task", threadId, "--text", "SECOND_ASK have Orchard count the orchard");
    await expect.poll(() => existsSync(files.askedReady), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => child(orchard.id)?.status, { timeout: 30_000 }).toBe("running");
    writeFileSync(files.askedRelease, "go");
    await expect.poll(waiting, { timeout: 30_000 }).toBe(true);

    rmSync(outOfUsage);
    writeFileSync(files.meadowRelease, "go");
    await expect.poll(() => child(meadow.id)?.status, { timeout: 30_000 }).toBe("completed");
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(await waiting()).toBe(true);
    expect(rootOf(meadow.id)?.status).toBe("resume");
    expect(await said("MEADOW_SUMMED_UP")).toBe(0);

    await expect.poll(() => said("CARRIED_ON"), { timeout: 60_000, interval: 500 }).toBe(1);
    await expect.poll(() => said("MEADOW_SUMMED_UP"), { timeout: 30_000, interval: 500 }).toBe(1);
    expect(rootOf(orchard.id)?.status).toBe("waiting");
    writeFileSync(files.orchardRelease, "go");
    await expect.poll(() => said("ORCHARD_SUMMED_UP"), { timeout: 60_000, interval: 500 }).toBe(1);
    await expect.poll(() => nodes().every(n => n.status === "completed"), { timeout: 10_000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(await said("ORCHARD_SUMMED_UP")).toBe(1);
    expect(await said("MEADOW_SUMMED_UP")).toBe(1);
    expect(nodes().filter(n => !n.parentId)).toHaveLength(2);
    expect((await rows()).find(row => row.role === "user" && row.text.startsWith("SECOND_ASK"))?.requestPending).toBe(false);
  } catch (error) {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(line => /token battery|room handoff|limit|pickup|carry/i.test(line)).slice(-60);
    console.info(JSON.stringify({ lines, nodes: nodes().map(n => ({ id: n.id.slice(0, 8), parent: n.parentId?.slice(0, 8), status: n.status, result: n.result?.slice(0, 60) })), rows: await transcript().catch(() => []) }, null, 1));
    throw error;
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 240_000);
