import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("reviews ordinary teammate renames through the real profile endpoint while rejecting broader and revoked changes", async () => {
  const gates = mkdtempSync(join(tmpdir(), "laterdog-peer-rename-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Rename proposer" }, 201)).bot;
    const target = (await api("POST", "/api/bots", { name: "Rename target" }, 201)).bot;
    await runControlLaterDog(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Propose the requested teammate rename.", "--url", fixture.info.url]);
    let token = "";
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.LATERDOG_COMMS_TOKEN; }
      catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    const propose = (changes: unknown, expected = 201, extra = {}) => api("POST", "/api/internal/profile-requests", {
      fromBotId: bot.id, fromThreadId: bot.threadId, forBotId: target.id, changes, reason: "Requested fixture rename", ...extra,
    }, expected, token);
    const confirm = (requestId: string, expected = 200) => api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, expected);
    const targetNow = async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === target.id);
    expect((await propose({ title: "Not permitted" }, 403)).error).toContain("beyond its name");
    expect((await propose({ name: "Changed" }, 403, { avatarPrompt: "A yellow dog" })).error).toContain("beyond its name");
    const revoked = await propose({ name: "Changed" });
    expect(revoked.state).toBe("pending");
    expect((await targetNow()).name).toBe("Rename target");
    await api("PATCH", `/api/bots/${bot.id}`, { peers: [] });
    expect((await confirm(revoked.requestId, 404)).error).toContain("reachable teammate");
    await api("PATCH", `/api/bots/${bot.id}`, { peers: [target.id], acknowledgePeerScope: true });
    await confirm(revoked.requestId, 409);
    const stale = await propose({ name: "Changed" });
    await api("PATCH", `/api/bots/${target.id}`, { description: "Updated since proposal" });
    expect((await confirm(stale.requestId, 409)).error).toContain("changed after this card");
    const fresh = await propose({ name: "Changed" });
    expect(fresh.state).toBe("pending");
    await confirm(fresh.requestId);
    expect((await targetNow()).name).toBe("Changed");
    const transcript = await api("GET", `/api/threads/${bot.threadId}/messages`);
    expect(transcript.messages.find((message: any) => message.card?.requestId === fresh.requestId)?.card)
      .toMatchObject({ answered: "allow", profileRequest: { targetBotId: target.id, changes: { name: "Changed" } } });
    const history = await api("GET", `/api/bots/${target.id}/history`);
    expect(history.rows.some((row: any) => row.field === "name" && row.before === "Rename target" && row.after === "Changed")).toBe(true);
    writeFileSync(gate, "finish");
  } finally {
    const evidencePath = `${fixture.info.logPath}.peer-rename.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close();
    await removeTempDir(gates);
  }
}, 60_000);
