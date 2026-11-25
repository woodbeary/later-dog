import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { request } from "../scripts/mcp-server.ts";

const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const REWOUND = "The person rewound this conversation";

async function fixture(test: (f: any) => Promise<void>, options: { claudeVersion?: string; claude?: Record<string, string>; codex?: Record<string, string> } = {}) {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "laterdog-fork-"));
  const logs = {
    chain: join(scratch, "claude-chain"), seen: join(scratch, "claude-seen.jsonl"), forks: join(scratch, "claude-forks.jsonl"),
    threads: join(scratch, "codex-threads"), codexSeen: join(scratch, "codex-seen.jsonl"), codexForks: join(scratch, "codex-forks.jsonl"),
  };
  const session = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_VERSION: options.claudeVersion ?? "2.1.316",
    FAKE_CLAUDE_CHAIN_DIR: logs.chain,
    FAKE_CLAUDE_SEEN_LOG: logs.seen,
    FAKE_CLAUDE_FORK_LOG: logs.forks,
    ...options.claude,
  }, undefined, undefined, undefined, undefined, undefined, options.codex ? ["codex"] : []);
  const url = session.info.url;
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  try {
    if (options.codex) {
      const wrapper = join(scratch, "codex.mjs");
      mkdirSync(logs.threads, { recursive: true });
      writeFileSync(wrapper, [
        "#!/usr/bin/env node",
        `Object.assign(process.env, ${JSON.stringify({ FAKE_CODEX_MODE: "happy", FAKE_CODEX_THREAD_DIR: logs.threads, FAKE_CODEX_SEEN_LOG: logs.codexSeen, FAKE_CODEX_FORK_LOG: logs.codexForks, ...options.codex })});`,
        `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "testing", "fake-codex-app-server.ts")).href)});`,
      ].join("\n"), { mode: 0o700 });
      await api("/api/instances/codex", { cli: wrapper }, "PATCH");
    }
    const bot = (await api("/api/bots?messages=0", undefined, "GET")).bots[0];
    const thread = bot.threadId;
    if (options.codex) {
      const model = (await cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
      await cli("set-model", "--bot", bot.id, "--instance", "codex", "--model", model, "--task", thread);
    }
    const wait = async () => expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "40")).status).toBe("settled");
    const send = async (text: string) => { await api(`/api/bots/${bot.id}/messages`, { text, threadId: thread }); await wait(); };
    const messages = async () => (await api(`/api/threads/${thread}/messages`, undefined, "GET")).messages as any[];
    const edit = async (messageId: string, text: string) => { await cli("edit", "--bot", bot.id, "--message", messageId, "--task", thread, "--text", text); await wait(); };
    await test({ api, cli, bot, thread, send, edit, messages, logs, dataDir: session.info.dataDir });
  } finally {
    await session.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function rewindOnce(f: any) {
  await f.send("KEEP_REQUEST: work only in the test workspace.");
  await f.send("ABANDONED_REQUEST");
  const dropped = (await f.messages()).findLast((m: any) => m.role === "user" && m.text === "ABANDONED_REQUEST");
  await f.edit(dropped.id, "REPLACEMENT_REQUEST");
  return dropped;
}

it("forks the Claude session at the kept reply, so the edited turn sees the kept turn and its tool results and not the dropped one", () => fixture(async (f) => {
  await rewindOnce(f);
  const fork = jsonl(f.logs.forks).findLast((line: any) => line.forked);
  expect(fork).toMatchObject({ forked: true, from: expect.any(String), at: expect.any(String) });
  const seen = jsonl(f.logs.seen).findLast((line: any) => line.prompt.includes("REPLACEMENT_REQUEST"));
  expect(seen.session).toBe(fork.session);
  expect(seen.session).not.toBe(fork.from);
  expect(seen.prompt).not.toContain(REWOUND);
  expect(seen.prompt).not.toContain("KEEP_REQUEST");
  const history = seen.history.map((entry: any) => `${entry.kind}: ${entry.text}`);
  expect(history.filter((line: string) => line.startsWith("prompt:"))).toEqual([expect.stringContaining("KEEP_REQUEST")]);
  expect(history).toEqual(expect.arrayContaining([expect.stringMatching(/^tool_use: .*echo hi/), "tool_result: hi", expect.stringMatching(/^assistant: /)]));
  expect(JSON.stringify(seen.history)).not.toContain("ABANDONED_");

  await f.send("FOLLOW_UP");
  const next = jsonl(f.logs.seen).findLast((line: any) => line.prompt.includes("FOLLOW_UP"));
  expect(next.session).toBe(fork.session);
  expect(next.prompt).not.toContain(REWOUND);
  expect(JSON.stringify(next.history)).toContain("REPLACEMENT_REQUEST");
  expect(JSON.stringify(next.history)).not.toContain("ABANDONED_");
  record("claude", { fork, edited: seen, followUp: next });
}), 120_000);

it("replays the kept history as text on a Claude CLI without fork-at-a-point, with no trace of the dropped turn", () => fixture(async (f) => {
  await rewindOnce(f);
  expect(jsonl(f.logs.forks).some((line: any) => line.forked)).toBe(false);
  const seen = jsonl(f.logs.seen).findLast((line: any) => line.prompt.includes("REPLACEMENT_REQUEST"));
  expect(seen.prompt).toContain(REWOUND);
  expect(seen.prompt).toContain("KEEP_REQUEST");
  expect(seen.history).toEqual([]);
  expect(seen.prompt).not.toContain("ABANDONED_");
  record("claude-old-cli", { edited: seen });
}, { claudeVersion: "2.1.270" }), 120_000);

it("forks the Codex thread through the kept turn, so the edited turn sees only the kept turn, then resumes the fork", () => fixture(async (f) => {
  await rewindOnce(f);
  const fork = jsonl(f.logs.codexForks).at(-1);
  expect(fork).toMatchObject({ from: expect.any(String), lastTurnId: expect.any(String), kept: 1 });
  const seen = jsonl(f.logs.codexSeen).findLast((line: any) => line.prompt.includes("REPLACEMENT_REQUEST"));
  expect(seen.thread).toBe(fork.thread);
  expect(seen.prompt).not.toContain(REWOUND);
  expect(seen.history.map((turn: any) => turn.prompt)).toEqual([expect.stringContaining("KEEP_REQUEST")]);
  expect(JSON.stringify(seen.history)).not.toContain("ABANDONED_");

  await f.send("FOLLOW_UP");
  const next = jsonl(f.logs.codexSeen).findLast((line: any) => line.prompt.includes("FOLLOW_UP"));
  expect(next.thread).toBe(fork.thread);
  expect(next.history.map((turn: any) => turn.prompt)).toEqual([expect.stringContaining("KEEP_REQUEST"), expect.stringContaining("REPLACEMENT_REQUEST")]);
  record("codex", { fork, edited: seen, followUp: next });
}, { codex: {} }), 120_000);

it("falls back to the text replay when the Codex fork comes back with the dropped turn still in it", () => fixture(async (f) => {
  await rewindOnce(f);
  const fork = jsonl(f.logs.codexForks).at(-1);
  expect(fork.kept).toBe(2);
  const seen = jsonl(f.logs.codexSeen).findLast((line: any) => line.prompt.includes("REPLACEMENT_REQUEST"));
  expect(seen.thread).not.toBe(fork.thread);
  expect(seen.history).toEqual([]);
  expect(seen.prompt).toContain(REWOUND);
  expect(seen.prompt).toContain("KEEP_REQUEST");
  expect(seen.prompt).not.toContain("ABANDONED_");
  record("codex-fork-ignored", { fork, edited: seen });
}, { codex: { FAKE_CODEX_FORK_IGNORES_TURN: "1" } }), 120_000);

it("does not record a native fork across a steer the engine never read", async () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "laterdog-unread-fork-"));
  const finish = join(scratch, "finish");
  const received = join(scratch, "received");
  try {
    await fixture(async (f) => {
      await f.api(`/api/bots/${f.bot.id}/messages`, { text: "KEEP_REQUEST", threadId: f.thread });
      await expect.poll(async () => (await f.messages()).some((message: any) => message.kind === "activity" && message.tool?.name === "Bash")).toBe(true);
      const sent = await f.api(`/api/bots/${f.bot.id}/messages`, { text: "UNREAD_STEER", threadId: f.thread });
      expect(sent.steered).toBe(true);
      await expect.poll(() => existsSync(received)).toBe(true);
      writeFileSync(finish, "finish");
      expect((await f.cli("wait", "--bot", f.bot.id, "--task", f.thread, "--timeout", "40")).status).toBe("settled");
      const messages = await f.messages();
      const unread = messages.find((message: any) => message.text === "UNREAD_STEER");
      expect(unread).toMatchObject({ steered: true });
      expect(unread.readAt).toBeUndefined();
      expect(messages.findLast((message: any) => message.role === "bot" && message.kind === "text").text).toContain("KEEP_REQUEST");
      const native = jsonl(f.logs.seen);
      expect(native).toHaveLength(1);
      expect(native[0].prompt).not.toContain("UNREAD_STEER");
      const file = join(f.dataDir, "engine-forks.json");
      const anchors = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      expect(anchors[f.thread]).toBeUndefined();
    }, { claude: {
      FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: finish,
      FAKE_CLAUDE_LATE_STEER_GATE: join(scratch, "continuation"),
      FAKE_CLAUDE_LATE_STEER_INIT_GATE: join(scratch, "init"),
      FAKE_CLAUDE_STEER_RECEIVED: received,
    } });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

function record(name: string, data: unknown) {
  const dir = join(process.cwd(), ".laterdog-evidence", "rewind-native-fork");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}
