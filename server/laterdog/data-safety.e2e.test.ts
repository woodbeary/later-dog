import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

type Message = { id: string; role: string; kind?: string; text?: string };
type CreatedBot = { id: string; name: string; threadId: string; messages: Message[] };

it("makes one dog per create id, says the first hello on the server, and keeps a damaged roster instead of reseeding it", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const evidence: Record<string, unknown> = { fixture: fixture.info };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; name: string }>;
  const messages = async (bot: CreatedBot) => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as Message[];
  try {
    expect((await api("PUT", "/api/config", { profile: { name: "Jacob" } })).status).toBe(200);
    const before = (await bots()).length;
    const createId = "sheet-3f1c0e4b8d7a4c1e";
    const first = await api("POST", "/api/bots", { name: "Scout", createId, hello: true });
    const again = await api("POST", "/api/bots", { name: "Scout", createId, hello: true });
    evidence.create = { first, again };
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const scout = first.body.bot as CreatedBot;
    expect(again.body.bot.id).toBe(scout.id);
    expect((await bots()).length).toBe(before + 1);
    expect(scout.messages.find((message) => message.role === "bot")?.text).toBe("Hi Jacob, I'm Scout.");
    await expect.poll(async () => (await messages(scout)).filter((message) => message.role === "bot").length, { timeout: 15_000 }).toBeGreaterThan(1);
    evidence.helloThread = await messages(scout);
    expect((await messages(scout)).some((message) => message.role === "user")).toBe(false);

    const old = await api("POST", "/api/bots", { name: "Old client" });
    expect(old.status).toBe(201);
    expect(old.body.bot.messages.filter((message: Message) => message.role === "bot").map((message: Message) => message.text)).toEqual(["Hi, I'm Old client. What would you like me to do?"]);
    expect((await api("POST", "/api/bots", { createId: "bad id" })).status).toBe(400);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const roster = readFileSync(join(dataDir, "bots.json"), "utf8");
    const truncated = roster.slice(0, Math.floor(roster.length / 2));
    writeFileSync(join(dataDir, "bots.json"), truncated);
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment(process.env, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await api("GET", "/api/health")).body.app; } catch { return null; }
    }, { timeout: 20_000, interval: 150 }).toBe("laterdog");

    const after = await bots();
    const config = (await api("GET", "/api/config")).body;
    const copies = readdirSync(dataDir).filter((name) => name.startsWith("bots.json.damaged-"));
    evidence.restart = { after, damagedData: config.damagedData, copies };
    expect(after).toEqual([]);
    expect(config.damagedData).toEqual([{ name: "bots", keptAs: copies[0] }]);
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dataDir, copies[0]!), "utf8")).toBe(truncated);
    expect(readFileSync(join(dataDir, "bots.json"), "utf8")).toBe(truncated);

    const replay = await api("POST", "/api/bots", { name: "Scout", createId });
    expect(replay.status).toBe(409);
    const fresh = await api("POST", "/api/bots", { name: "Fresh" });
    expect(fresh.status).toBe(201);
    expect((await bots()).map((bot) => bot.name)).toEqual(["Fresh"]);
    expect(readFileSync(join(dataDir, copies[0]!), "utf8")).toBe(truncated);
    const evidencePath = `${logPath}.data-safety.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath }));
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
