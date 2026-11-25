import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { cloudPairingSignature } from "../cloud-home.ts";
import { markLeftBehind } from "../testing/cloud-left-behind.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { leasePortBlock } from "../testing/ports.ts";
import { logArchiveBridge } from "./log-archive.ts";
import { MOVED_OUT_NOTE, WORK_FOLDER_RECORDS, WorkFolderArchive } from "./work-folder-archive.ts";

const { createArchiver, serveArchive } = (await import(
  new URL("../../deploy/laterdog/home/runtime/archive.mjs", import.meta.url).href
)) as {
  createArchiver(options: {
    root: string;
    store: {
      archiveIndex(): Promise<unknown>;
      putArchiveIndex(index: unknown): Promise<void>;
      hasArchived(hash: string): Promise<boolean>;
      putArchived(hash: string, bytes: Uint8Array): Promise<void>;
      getArchived(hash: string): Promise<Uint8Array>;
    };
  }): unknown;
  serveArchive(
    archiver: unknown,
    options: { token: string },
  ): Promise<{ close(): Promise<void>; url: string }>;
};

type Bot = { id: string; threadId: string; tasks: Array<{ threadId: string; busy?: boolean }> };
type Group = { id: string; threadId: string; working: boolean };
type Storage = { workFolders: { out: number; broughtBack: number; lastSweepAt: number | null } };

it("keeps missing known chat folders through the production background sweep and restores direct and guest group turns", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "work-folder-home-")));
  const dataDir = join(home, ".laterdog");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const port = await leasePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const host = "laterdog-t-0123456789ab.fly.dev";
  const secret = randomBytes(32).toString("base64url");
  const token = "synthetic-missing-folder-archive";
  const evidence = join(tmpdir(), "laterdog-verification-evidence");
  mkdirSync(evidence, { recursive: true });
  const logPath = join(evidence, `work-folder-${randomUUID()}.log`);
  const dump = join(home, "engine.json");
  const prompts = join(home, "prompts.jsonl");
  let child: ChildProcess | undefined;
  let service: { close(): Promise<void>; url: string } | undefined;
  let cloud = false;
  let owner = "";
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(cloud
          ? {
              host,
              "x-forwarded-for": "203.0.113.9",
              "x-forwarded-proto": "https",
              origin: `https://${host}`,
            }
          : { origin: base }),
        ...(owner ? { authorization: `Bearer ${owner}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json();
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value as T;
  };
  const start = async (asCloud: boolean) => {
    cloud = asCloud;
    const env = verificationServerEnvironment({}, home, port);
    symlinkSync("/bin/tar", join(home, ".cache", "fixture-bin", "tar"));
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    const fd = openSync(logPath, "a", 0o600);
    child = spawn(
      process.execPath,
      ["--import", offline, fileURLToPath(new URL("../index.ts", import.meta.url))],
      {
        env: {
          ...env,
          LATERDOG_HOME: dataDir,
          LATERDOG_CLOUD_SECRETS_FD: "3",
          ...(asCloud
            ? {
                LATERDOG_CLOUD_ROLE: "home",
                LATERDOG_CLOUD_MACHINE_ID: "archive-verification-home",
                LATERDOG_CLOUD_ADMIN_URL: "https://cloud.example.test",
                LATERDOG_PUBLIC_URL: `https://${host}`,
                LATERDOG_CLOUD_ARCHIVE_URL: service!.url,
              }
            : {}),
        },
        stdio: ["ignore", fd, fd, "pipe"],
      },
    );
    (child.stdio[3] as NodeJS.WritableStream).end(
      JSON.stringify(
        asCloud
          ? { LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_CLOUD_ARCHIVE_TOKEN: token }
          : {},
      ),
    );
    closeSync(fd);
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
          try {
            return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  };
  const shutdown = async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    child = undefined;
    rmSync(join(home, ".cache", "fixture-bin", "tar"));
  };
  try {
    const cli = join(home, "engine.mjs");
    writeFileSync(
      cli,
      `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump)};
process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(prompts)};
process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";
await import(${JSON.stringify(new URL("../testing/fake-claude-cli.ts", import.meta.url).href)});
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        instances: {
          ...Object.fromEntries(
            ["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [
              id,
              { driver: "not-a-real-driver" },
            ]),
          ),
          fixture: { driver: "claudeAgent", displayName: "Archive fixture", config: { cli } },
        },
      }),
    );
    await start(false);
    const { bot } = await request<{ bot: Bot }>("POST", "/api/bots", {
      name: "Archive keeper",
      computer: "off",
      modelSelection: { instanceId: "fixture", model: "claude-sonnet-5" },
    });
    const { task } = await request<{ task: { threadId: string } }>(
      "POST",
      `/api/bots/${bot.id}/tasks`,
      { title: "Other work" },
    );
    const { group } = await request<{ group: Group }>("POST", "/api/groups", {
      name: "Shared work",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    const { task: groupTask } = await request<{ task: { threadId: string } }>(
      "POST",
      `/api/groups/${group.id}/tasks`,
      { title: "Guest work" },
    );
    await shutdown();
    markLeftBehind(dataDir, { threadIds: [group.threadId, groupTask.threadId] });
    const threads = [bot.threadId, task.threadId, group.threadId, groupTask.threadId];
    const unknown = randomUUID();
    const workspacesDir = join(dataDir, "task-workspaces");
    const paths = [...threads, unknown].map((threadId) => join(workspacesDir, bot.id, threadId));
    const bytes = new Map(
      paths.map((dir, index) => [dir, Buffer.from(`synthetic archived work ${index}\n`)]),
    );
    for (const dir of paths) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.txt"), bytes.get(dir)!, { mode: 0o640 });
    }
    const blobs = new Map<string, Uint8Array>();
    let index: unknown = null;
    let unavailable = false;
    let downloadAttempts = 0;
    service = await serveArchive(
      createArchiver({
        root: home,
        store: {
          archiveIndex: async () => structuredClone(index),
          putArchiveIndex: async (next) => {
            index = structuredClone(next);
          },
          hasArchived: async (hash) => blobs.has(hash),
          putArchived: async (hash, value) => {
            blobs.set(hash, new Uint8Array(value));
          },
          getArchived: async (hash) => {
            downloadAttempts += 1;
            if (unavailable) throw new Error("synthetic storage outage");
            const value = blobs.get(hash);
            if (!value) throw new Error("missing synthetic archive bytes");
            return value;
          },
        },
      }),
      { token },
    );
    const archived = new WorkFolderArchive({
      home,
      dataDir,
      workspacesDir,
      bridge: logArchiveBridge(service.url, token),
      chats: () => paths.map((dir) => ({ dir, busy: false, closed: false, lastActiveAt: 0 })),
      live: () => [],
      limits: () => ({ idleMs: 1, byteLimit: Infinity, minFiles: 0, minBytes: 0 }),
      room: () => true,
    });
    expect(await archived.sweep()).toBeGreaterThan(0);
    for (const dir of paths) {
      expect(existsSync(join(dir, MOVED_OUT_NOTE))).toBe(true);
      rmSync(dir, { recursive: true });
    }
    const recordPath = join(dataDir, WORK_FOLDER_RECORDS);
    expect(Object.keys(JSON.parse(readFileSync(recordPath, "utf8")))).toHaveLength(5);
    await start(true);
    const body = JSON.stringify({ label: "Archive verification", ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("base64url");
    const pairing = await fetch(base + "/api/cloud/pairing", {
      method: "POST",
      headers: {
        host,
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
        "x-laterdog-cloud-timestamp": timestamp,
        "x-laterdog-cloud-nonce": nonce,
        "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    expect(pairing.ok).toBe(true);
    const granted = (await pairing.json()) as { code: string };
    owner = (await request<{ token: string }>("POST", "/api/auth/pair", { code: granted.code }))
      .token;
    await expect
      .poll(async () => (await request<Storage>("GET", "/api/storage")).workFolders.lastSweepAt, {
        timeout: 80_000,
        interval: 250,
      })
      .not.toBeNull();
    const records = Object.keys(JSON.parse(readFileSync(recordPath, "utf8"))).sort();
    const expected = threads.map((thread) => `${bot.id}/${thread}`).sort();
    console.info(
      JSON.stringify({
        backgroundSweep: true,
        missingLocalFolders: paths.every((dir) => !existsSync(dir)),
        retainedRecords: records,
        expectedRecords: expected,
        logPath,
      }),
    );
    expect(records).toEqual(expected);
    const stoppedText = "STOP_WHILE_RESTORING_GUEST_WORK";
    downloadAttempts = 0;
    unavailable = true;
    await request("POST", `/api/groups/${group.id}/tasks/${groupTask.threadId}`, {});
    await request("POST", `/api/groups/${group.id}/messages`, {
      text: stoppedText,
      threadId: groupTask.threadId,
    });
    await expect.poll(() => downloadAttempts, { timeout: 30_000 }).toBeGreaterThan(0);
    await request("POST", `/api/groups/${group.id}/interrupt`, { threadId: groupTask.threadId });
    await expect
      .poll(
        async () =>
          (await request<{ groups: Group[] }>("GET", "/api/bots?messages=0")).groups.find(
            (value) => value.id === group.id,
          )?.working,
        { timeout: 30_000 },
      )
      .toBe(false);
    expect(downloadAttempts).toBe(1);
    expect(
      JSON.parse(readFileSync(recordPath, "utf8"))[`${bot.id}/${groupTask.threadId}`],
    ).toBeDefined();
    expect(existsSync(prompts) && readFileSync(prompts, "utf8").includes(stoppedText)).toBe(false);
    unavailable = false;
    console.info(
      JSON.stringify({
        stoppedGuestRestoreSettled: true,
        outageAttempts: downloadAttempts,
        pendingRecordPreserved: true,
      }),
    );
    for (const threadId of threads) {
      const text = `RESTORE_WORK_${threadId}`;
      if (threadId === bot.threadId || threadId === task.threadId) {
        await request("POST", `/api/bots/${bot.id}/messages`, { text, threadId });
      } else {
        await expect
          .poll(
            async () =>
              (await request<{ groups: Group[] }>("GET", "/api/bots?messages=0")).groups.find(
                (value) => value.id === group.id,
              )?.working,
            { timeout: 30_000 },
          )
          .toBe(false);
        await request("POST", `/api/groups/${group.id}/tasks/${threadId}`, {});
        await request("POST", `/api/groups/${group.id}/messages`, { text, threadId });
      }
      const dir = join(workspacesDir, bot.id, threadId);
      await expect
        .poll(
          () =>
            existsSync(join(dir, "result.txt")) &&
            readFileSync(join(dir, "result.txt")).equals(bytes.get(dir)!),
          { timeout: 30_000 },
        )
        .toBe(true);
      try {
        await expect
          .poll(() => existsSync(prompts) && readFileSync(prompts, "utf8").includes(text), {
            timeout: 30_000,
          })
          .toBe(true);
      } catch (error) {
        console.info(
          JSON.stringify({
            engineDidNotStart: true,
            threadId,
            transcript: await request("GET", `/api/threads/${threadId}/messages`),
          }),
        );
        throw error;
      }
      expect(statSync(join(dir, "result.txt")).mode & 0o777).toBe(0o640);
      expect(JSON.parse(readFileSync(dump, "utf8")).cwd).toBe(dir);
      expect(JSON.parse(readFileSync(recordPath, "utf8"))[`${bot.id}/${threadId}`]).toBeUndefined();
      await expect
        .poll(
          async () =>
            (await request<{ bots: Bot[] }>("GET", "/api/bots")).bots
              .find((value) => value.id === bot.id)
              ?.tasks.some((value) => value.busy),
          { timeout: 30_000 },
        )
        .toBe(false);
      await expect
        .poll(
          async () =>
            (await request<{ groups: Group[] }>("GET", "/api/bots?messages=0")).groups.find(
              (value) => value.id === group.id,
            )?.working,
          { timeout: 30_000 },
        )
        .toBe(false);
    }
    expect((await request<Storage>("GET", "/api/storage")).workFolders).toMatchObject({
      out: 0,
      broughtBack: 4,
    });
    console.info(
      JSON.stringify({
        restoredDirect: 2,
        restoredGuestGroup: 2,
        bytesAndModesPreserved: true,
        unknownRecordDropped: true,
      }),
    );
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await service?.close();
    await removeTempDir(home);
  }
}, 180_000);
