import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";

it("reports a crashed run to the Chief, who retries it from the incidents thread", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, token?: string, expectedStatus = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expectedStatus);
    return value;
  };
  const control = (args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const file = (threadId: string, extension: string) => join(dataDir, `${threadId}.${extension}`);
  const dump = async (threadId: string) => {
    await expect.poll(() => existsSync(file(threadId, "json")), { timeout: 20_000 }).toBe(true);
    return JSON.parse(readFileSync(file(threadId, "json"), "utf8"));
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const botsNow = async () => (await api("GET", "/api/bots")).bots as any[];
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    const fixedFlag = join(dataDir, "ada-fixed");

    const wrapper = join(dataDir, "incident-cli.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const at = process.argv.indexOf("--mcp-config");',
      'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.LATERDOG_THREAD_ID ?? "probe";',
      `process.env.FAKE_CLAUDE_MODE = thread === "probe" ? "happy" : thread === ${JSON.stringify(ada.activeTaskId)} && !existsSync(${JSON.stringify(fixedFlag)}) ? "exit-early" : "slow";`,
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(dataDir)}, thread + ".gate");`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(dataDir)}, thread + ".json");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });

    await control(["send", "--bot", ada.id, "--text", "Reconcile the September invoices."]);
    await expect.poll(async () => (await messages(ada.activeTaskId)).some((m) => m.kind === "activity" && /exit_before_result|error/i.test(m.tool?.name ?? "")), { timeout: 20_000 }).toBe(true);

    await expect.poll(async () => (await botsNow()).find((b) => b.id === chief.id)?.tasks?.some((t: any) => t.title === "Team incidents"), { timeout: 20_000 }).toBe(true);
    const incidents = (await botsNow()).find((b) => b.id === chief.id).tasks.find((t: any) => t.title === "Team incidents");
    await expect.poll(async () => (await messages(incidents.threadId)).some((m) =>
      m.kind === "activity" && m.tool?.name === 'Incident: Ada\'s run in its thread #Reconcile the September invoices. failed: "exit_before_result"' && m.threadRef?.threadId === ada.activeTaskId && m.threadRef?.botId === ada.id,
    ), { timeout: 10_000 }).toBe(true);
    const chiefRun = await dump(incidents.threadId);
    const prompt = JSON.stringify(chiefRun.prompt);
    expect(prompt).toContain("[Incident report from later.dog — not from the person.");
    expect(prompt).toContain("Ada's run in its thread #Reconcile the September invoices. failed");
    expect(prompt).toContain("Reconcile the September invoices.");
    expect(prompt).toContain(`retry_thread with bot_id \\"${ada.id}\\" and thread_id \\"${ada.activeTaskId}\\"`);
    expect(chiefRun.systemPrompt).toContain("Team incidents");
    expect(chiefRun.systemPrompt).toContain("retry_thread");
    const reportLine = (await messages(incidents.threadId)).find((m) => m.role === "user" && /Incident report/.test(m.text ?? ""));
    expect(reportLine?.peerAsk).toMatchObject({ botId: ada.id, name: "Ada", unattended: true });

    const token = chiefRun.mcpConfig.mcpServers.agents.env.LATERDOG_COMMS_TOKEN;
    writeFileSync(fixedFlag, "fixed");
    const retry = { fromBotId: chief.id, fromThreadId: incidents.threadId, toBotId: ada.id, toThreadId: ada.activeTaskId };
    expect(await api("POST", "/api/internal/retry-thread", { ...retry, note: "The service was down; try again." }, token, 200)).toMatchObject({ started: true });
    expect((await api("POST", "/api/internal/retry-thread", retry, token, 409)).error).toMatch(/still running/);
    expect((await api("POST", "/api/internal/retry-thread", { ...retry, toThreadId: "no-such-thread" }, token, 404)).error).toMatch(/no such thread/);
    writeFileSync(file(incidents.threadId, "gate"), "finish");
    expect((await control(["wait", "--bot", chief.id, "--task", incidents.threadId, "--timeout", "30"])).status).toBe("settled");

    writeFileSync(file(ada.activeTaskId, "gate"), "finish");
    await expect.poll(async () => (await control(["wait", "--bot", ada.id, "--timeout", "30"])).status, { timeout: 40_000 }).toBe("settled");
    const adaMessages = await messages(ada.activeTaskId);
    const retryLine = adaMessages.find((m) => m.role === "user" && /Retry requested by Clive, your Chief of Staff/.test(m.text ?? ""));
    expect(retryLine?.text).toContain("Note from Clive: The service was down; try again.");
    expect(retryLine?.peerAsk).toMatchObject({ botId: chief.id, name: "Clive" });
    expect(adaMessages.filter((m) => m.role === "bot" && m.kind === "text" && m.text).length).toBeGreaterThan(0);
    expect((await messages(incidents.threadId)).some((m) => m.kind === "activity" && (m.tool?.name ?? "").startsWith("Retried Ada's thread #") && m.threadRef?.threadId === ada.activeTaskId)).toBe(true);

    const adaRun = JSON.parse(readFileSync(file(ada.activeTaskId, "json"), "utf8"));
    const adaToken = adaRun.mcpConfig.mcpServers.agents.env.LATERDOG_COMMS_TOKEN;
    const refused = await fetch(`${url}/api/internal/retry-thread`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adaToken}` },
      body: JSON.stringify({ fromBotId: ada.id, fromThreadId: ada.activeTaskId, toBotId: chief.id, toThreadId: incidents.threadId }),
    });
    expect([401, 403]).toContain(refused.status);
  } finally {
    await fixture.close();
  }
}, 150_000);
