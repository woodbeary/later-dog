import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../../../scripts/control-laterdog.ts";
import { spawnWithSecrets } from "../../../../server/cloud-home-start.ts";
import { waitForExit } from "../../../../server/testing/cleanup.ts";
import { createArchiver, serveArchive } from "../runtime/archive.mjs";

it("retains a closed-chat pending send across server restart and dispatches only after logs return", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  let service: { url: string; close(): Promise<void> } | undefined;
  const api = async (path: string) => {
    const response = await fetch(url + path, { signal: AbortSignal.timeout(2000) });
    expect(response.ok).toBe(true);
    return response.json();
  };
  try {
    const { bot } = await runControlLaterDog(["new-bot", "--name", "Archive fixture", "--url", url]) as any;
    const id = bot.activeTaskId;
    await expect.poll(async () => {
      const bots = await api("/api/bots");
      return bots.bots.find((value: any) => value.id === bot.id).tasks.find((value: any) => value.threadId === id).busy;
    }, { timeout: 30_000 }).toBe(false);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const home = join(dataDir, ".laterdog");
    mkdirSync(home);
    for (const name of readdirSync(dataDir)) {
      if (name === ".laterdog" || name === "tmp") continue;
      cpSync(join(dataDir, name), join(home, name), { recursive: true });
    }
    const prompts = join(dataDir, "archive-prompts.jsonl");
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TOOL_CALLS: "[]" };
    writeFileSync(configPath, JSON.stringify(config));
    const eventPath = `.laterdog/events/${id}.ndjson`;
    const saved = JSON.stringify({ eventId: "archive-event", provider: "claudeAgent", providerInstanceId: "claude", threadId: id,
      turnId: "old-turn", createdAt: new Date(0).toISOString(), type: "content.delta", delta: "ARCHIVE_FIXTURE_HISTORY", itemId: "old-item", streamKind: "assistant_text" }) + "\n";
    writeFileSync(join(dataDir, eventPath), saved);
    const blobs = new Map<string, Uint8Array>();
    let index: unknown = null;
    let unavailable = false;
    let attempts = 0;
    const store = {
      async archiveIndex() { return structuredClone(index); },
      async putArchiveIndex(next: unknown) { index = structuredClone(next); },
      async hasArchived(hash: string) { return blobs.has(hash); },
      async putArchived(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
      async getArchived(hash: string) {
        attempts++;
        if (unavailable) throw new Error("fixture outage");
        const found = blobs.get(hash);
        if (!found) throw new Error("missing");
        return found;
      },
    };
    const archive = createArchiver({ root: dataDir, store });
    expect(await archive.archive([eventPath])).toMatchObject({ archived: 1 });
    service = await serveArchive(archive, { token: "server-archive-fixture" });
    const start = async () => {
      const log = openSync(logPath, "a", 0o600);
      const env = {
        ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
        LATERDOG_HOME: home, LATERDOG_CLOUD_ARCHIVE_URL: service!.url, LATERDOG_CLOUD_SECRETS_FD: "3",
      };
      server = spawnWithSecrets(process.execPath,
        ["--experimental-strip-types", fileURLToPath(new URL("../../../../server/index.ts", import.meta.url))],
        env, { LATERDOG_CLOUD_ARCHIVE_TOKEN: "server-archive-fixture" }, { stdio: ["ignore", log, log] });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
      }, { timeout: 30_000 }).toBe(true);
    };
    unavailable = true;
    await start();
    const baseline = attempts;
    await runControlLaterDog(["send", "--bot", bot.id, "--task", id, "--text", "CONTINUE_AFTER_ARCHIVE_OUTAGE", "--url", url]);
    await expect.poll(() => attempts, { timeout: 10_000 }).toBeGreaterThan(baseline);
    expect(existsSync(prompts)).toBe(false);
    expect(existsSync(join(dataDir, eventPath))).toBe(false);
    await waitForExit(server, { signal: "SIGTERM" });
    server = undefined;
    const priorRestart = attempts;
    await start();
    await expect.poll(() => attempts, { timeout: 20_000 }).toBeGreaterThan(priorRestart);
    expect(existsSync(prompts)).toBe(false);
    unavailable = false;
    await expect.poll(() => existsSync(prompts) ? readFileSync(prompts, "utf8") : "", { timeout: 30_000 }).toContain("CONTINUE_AFTER_ARCHIVE_OUTAGE");
    expect(readFileSync(join(dataDir, eventPath), "utf8")).toContain("ARCHIVE_FIXTURE_HISTORY");
    const history = await api(`/api/threads/${id}/events`);
    expect(JSON.stringify(history)).toContain("ARCHIVE_FIXTURE_HISTORY");
    console.info(JSON.stringify({ logPath, archiveRestoreAttempts: attempts, closedChat: true, restarted: true }));
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await service?.close();
    await fixture.close();
  }
}, 120_000);
