import type { ModelSelection } from "../shared/wire.ts";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { callTool } from "./drivers/agents-call.ts";
import { createHarnessClient } from "./drivers/agents-client.ts";
import { readUsage, appendUsage, flushUsageLedger } from "./usage-ledger.ts";

it("a dog consults advice through its real tool capability without changing its selected model", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  const api = async (path: string) => {
    const response = await fetch(url + path, { headers: { origin: url } });
    expect(response.ok).toBe(true);
    return response.json() as Promise<{ bots: Array<{ id: string; threadId: string; modelSelection: ModelSelection }> }>;
  };
  const evidenceDir = join(process.cwd(), ".laterdog-evidence", "execution-advisor");
  mkdirSync(evidenceDir, { recursive: true });
  try {
    const initial = (await api("/api/bots?messages=0")).bots[0];
    await runControlLaterDog(["send", "--url", url, "--bot", initial.id, "--task", initial.threadId, "--text", "Inspect fixture account controls"], {});
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env; } catch { return undefined; }
    }, { timeout: 15_000 }).toBeDefined();
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const env = dump.mcpConfig.mcpServers.agents.env;
    const client = createHarnessClient(url, env.LATERDOG_COMMS_TOKEN);
    await appendUsage(dataDir, { botId: "another-dog", botName: "Private", threadId: "private-thread", instanceId: "claude", driverKind: "claudeAgent", model: initial.modelSelection.model, input: 10, output: 10, costUsd: 1, trigger: { kind: "owner" } });
    await flushUsageLedger(dataDir);
    const reply = await callTool("execution_advice", { task: "Inspect account controls" }, { botId: initial.id, threadId: initial.threadId, depth: 0, sharedComputers: false, client });
    const advice = JSON.parse(reply.text);
    expect(advice.recommendation).toMatchObject({ action: "keep_current", selection: initial.modelSelection });
    expect(advice.coverage.recordedTurns).toBe(0);
    expect(JSON.stringify(advice)).not.toContain("private-thread");
    const invalid = await client.apiResponse("/api/internal/execution-advice", { method: "POST", body: JSON.stringify({ task: "inspect", botId: "another-dog" }) });
    expect(invalid.status).toBe(403);
    const beforeStop = (await api("/api/bots?messages=0")).bots[0];
    expect(beforeStop.modelSelection).toEqual(initial.modelSelection);
    await runControlLaterDog(["interrupt", "--url", url, "--bot", initial.id, "--task", initial.threadId], {});
    await expect.poll(() => readUsage(dataDir, { from: new Date(0), to: new Date() }).filter((row) => row.botId === initial.id), { timeout: 15_000 }).not.toHaveLength(0);
    const rows = readUsage(dataDir, { from: new Date(0), to: new Date() }).filter((row) => row.botId === initial.id);
    expect(rows.at(-1)?.execution).toMatchObject({ selected: initial.modelSelection, dispatched: initial.modelSelection, verification: "unverified", providerSucceeded: false });
    const monitorResponse = await fetch(url + "/api/usage/executions?limit=20", { headers: { origin: url } });
    expect(monitorResponse.status).toBe(200);
    const monitor = await monitorResponse.json() as { receipts: Array<{ botId: string }> };
    expect(monitor.receipts.some((receipt) => receipt.botId === initial.id)).toBe(true);
    const expired = await client.apiResponse("/api/internal/execution-advice", { method: "POST", body: JSON.stringify({ task: "inspect" }) });
    expect(expired.status).toBe(401);
    writeFileSync(join(evidenceDir, "receipt.json"), JSON.stringify({ url, logPath, advice, execution: rows.at(-1)?.execution, selectedBefore: initial.modelSelection, selectedAfter: beforeStop.modelSelection, expiredCapabilityStatus: expired.status }, null, 2));
  } finally {
    await fixture.close();
    writeFileSync(join(evidenceDir, "server.log"), readFileSync(logPath));
  }
}, 60_000);
