import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const INCLUDED_REPLY = "INCLUDED_AI_REPLIED_4K";
const TRIAL_KEY = `ldt_${"a".repeat(43)}`;

it("moves a dog saved on Gemini onto the included AI at start, keeps its history, and replies there", async () => {
  const asked: Array<{ path: string; model: unknown }> = [];
  const included: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/ai/chat/completions") { res.writeHead(404).end(); return; }
      const parsed = JSON.parse(body) as { model?: unknown };
      asked.push({ path: req.url, model: parsed.model });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "fixture", object: "chat.completion", model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: INCLUDED_REPLY }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((resolve) => included.listen(0, "127.0.0.1", resolve));
  const includedPort = (included.address() as AddressInfo).port;

  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const evidence: unknown[] = [{ url, dataDir }];
  const api = async (path: string) => {
    const response = await fetch(url + path, { headers: { origin: url }, signal: AbortSignal.timeout(30_000) });
    expect(response.status, path).toBe(200);
    return response.json() as Promise<any>;
  };
  const control = async (...args: string[]) => {
    const result = await runControlLaterDog([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const { bot } = await control("new-bot", "--name", "Gemini dog");
    await control("send", "--bot", bot.id, "--text", "REMEMBER_BEFORE_TRIM_5L");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.gemini = { driver: "geminiAgent", displayName: "Gemini" };
    writeFileSync(configPath, JSON.stringify(config));
    const botsPath = join(dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(botsPath, "utf8")) as any[];
    const gemini = { instanceId: "gemini", model: "gemini-3-pro" };
    for (const saved of bots.filter((entry) => entry.id === bot.id)) {
      saved.modelSelection = gemini;
      for (const task of saved.tasks ?? []) if (task.modelSelection) task.modelSelection = gemini;
    }
    writeFileSync(botsPath, JSON.stringify(bots));
    writeFileSync(join(dataDir, "computers-trial.json"), JSON.stringify({ api: `http://127.0.0.1:${includedPort}/v1`, confirmed: true, included: ["ai"] }));
    writeFileSync(join(dataDir, "computers-trial-key"), `${TRIAL_KEY}\n`, { mode: 0o600 });

    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const moved = (await api("/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(moved.modelSelection).toEqual({ instanceId: "laterdogAi", model: "kimi-k2.6" });
    const instances = (await api("/api/instances")).instances as Array<{ instanceId: string; driverKind: string }>;
    evidence.push({ instances: instances.map(({ instanceId, driverKind }) => ({ instanceId, driverKind })) });
    expect(instances.map((instance) => instance.instanceId)).not.toContain("gemini");
    expect(instances.map((instance) => instance.driverKind)).not.toContain("geminiAgent");

    await control("send", "--bot", bot.id, "--text", "Are you still there?");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const messages = (await control("messages", "--bot", bot.id, "--limit", "50")).messages as any[];
    evidence.push({ asked, messages });
    expect(messages.some((message) => message.role === "user" && message.text === "REMEMBER_BEFORE_TRIM_5L")).toBe(true);
    expect(messages.some((message) => message.kind === "activity" &&
      message.tool?.name?.startsWith("Gemini dog now uses Kimi. The model it used before is no longer offered."))).toBe(true);
    expect(messages.some((message) => message.role === "bot" && message.kind === "text" && message.text?.includes(INCLUDED_REPLY))).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((request) => request.model === "kimi-k2.6")).toBe(true);
  } finally {
    const evidencePath = `${logPath}.engine-trim.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    await new Promise<void>((resolve) => included.close(() => resolve()));
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
