import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QUESTION_DISMISS_MESSAGE } from "../shared/ask-question.ts";
import { brokerSocketPath } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "permission-proxy.ts");

const QUESTION = {
  questions: [
    {
      question: "Which framework should we use?",
      header: "Framework",
      multiSelect: false,
      options: [
        { label: "React", description: "What the app already uses" },
        { label: "Vue", description: "Smaller, but a rewrite" },
      ],
    },
  ],
};

describe("permission proxy", () => {
  let scratch: string;
  let broker: Server;
  let proxy: ChildProcess;
  let asks: any[];
  let answerWith: (ask: any, index: number) => Record<string, unknown> | null;
  let conns: Socket[];
  const results = new Map<number, any>();

  const rpc = (msg: unknown) => proxy.stdin!.write(JSON.stringify(msg) + "\n");
  const waitFor = async (id: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no response for id ${id}; asks so far: ${JSON.stringify(asks)}`);
  };
  const waitForAsks = async (count: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (asks.length >= count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`only ${asks.length} of ${count} asks arrived`);
  };
  const resultJson = (res: any) => JSON.parse(res.result.content[0].text);

  const startProxy = (socketPath: string, env?: NodeJS.ProcessEnv) => {
    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY, socketPath], { stdio: ["pipe", "pipe", "pipe"], env });
    let out = "";
    proxy.stdout!.setEncoding("utf8");
    proxy.stdout!.on("data", (chunk) => {
      out += chunk; let nl;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        if (!line.trim()) continue;
        try { const msg = JSON.parse(line); if (msg.id != null) results.set(msg.id, msg); } catch {}
      }
    });
  };

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "laterdog-perm-proxy-"));
    asks = [];
    conns = [];
    answerWith = () => null;
    const socketPath = brokerSocketPath(scratch, "test");
    broker = createServer((conn: Socket) => {
      conns.push(conn);
      let buf = "";
      conn.on("error", () => {});
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ask = JSON.parse(line);
          if (ask.t !== "ask") continue;
          const index = asks.length;
          asks.push(ask);
          const answer = answerWith(ask, index);
          if (answer) conn.write(JSON.stringify({ t: "answer", id: ask.id, ...answer }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));

    startProxy(socketPath);
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 20_000);

  afterEach(async () => {
    results.clear();
    proxy?.kill();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    removeTempDir(scratch);
  });

  it("withholds an excluded question without losing the CLI permission callback", async () => {
    const exited = once(proxy, "exit"); proxy.kill(); await exited; results.clear();
    startProxy(brokerSocketPath(scratch, "test"), { ...process.env, LATERDOG_PERMISSION_TOOL_SCOPE: JSON.stringify({ allow: ["native:*"] }) });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await waitFor(2)).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["approve"]);
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_user", arguments: { question: "Must not ask" } } });
    expect((await waitFor(3)).result.content[0].text).toContain("excluded"); expect(asks).toEqual([]);
    answerWith = () => ({ behavior: "allow" });
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Read", input: {} } } });
    expect(resultJson(await waitFor(4)).behavior).toBe("allow"); expect(asks).toHaveLength(1);
  });

  it("exposes approve and ask_user", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    expect(res.result.tools.map((tool: any) => tool.name)).toEqual(["approve", "ask_user"]);
  });

  it("asks AskUserQuestion as ONE question card carrying every question it posed", async () => {
    answerWith = () => ({
      behavior: "answer",
      message: "The user answered your questions.\n\nQ: Which framework should we use?\nA: React",
      source: "user",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    const res = await waitFor(2);

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      kind: "question",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which framework should we use?",
            options: [
              { label: "React", description: "What the app already uses" },
              { label: "Vue", description: "Smaller, but a rewrite" },
            ],
          },
        ],
      },
    });

    expect(resultJson(res)).toEqual({
      behavior: "allow",
      updatedInput: { ...QUESTION, answers: { "Which framework should we use?": "React" } },
    });
  });

  it("returns an answer for every question the one card collected", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { question: "Which features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Search" }] },
      ],
    };
    answerWith = () => ({
      behavior: "answer",
      message:
        "The user answered your questions.\n\nQ: Which framework?\nA: React\n\nQ: Which features?\nA: Auth, Search",
      source: "user",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);

    expect(asks).toHaveLength(1);
    expect(asks[0].input.questions.map((q: { question: string }) => q.question))
      .toEqual(["Which framework?", "Which features?"]);
    expect(asks[0].input.questions[1].multiSelect).toBe(true);
    expect(resultJson(res).updatedInput.answers).toEqual({
      "Which framework?": "React",
      "Which features?": "Auth, Search",
    });
  });

  it("hands the dog the close note for every question when the person closes the card", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { question: "Which features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Search" }] },
      ],
    };
    answerWith = () => ({ behavior: "answer", message: QUESTION_DISMISS_MESSAGE, source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    expect(resultJson(await waitFor(2))).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Which framework?": QUESTION_DISMISS_MESSAGE, "Which features?": QUESTION_DISMISS_MESSAGE },
      },
    });
  });

  it("files a timeout's own note as unanswered, not as the user's choice", async () => {
    answerWith = () => ({
      behavior: "answer",
      message: "later.dog: nobody answered in time. Use your best judgment and continue.",
      source: "timeout",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2)).updatedInput.answers).toEqual({});
  });

  it("treats the turn ending the same way — system words are not the user's answer", async () => {
    answerWith = () => ({
      behavior: "answer",
      message: "later.dog: the turn is ending — wrap up.",
      source: "system",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2)).updatedInput.answers).toEqual({});
  });

  it("denies when the broker is gone, rather than reporting an empty answer", async () => {
    answerWith = () => ({ behavior: "deny", message: "later.dog: permission broker unavailable" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2))).toMatchObject({ behavior: "deny" });
  });

  it("denies an unanswerable AskUserQuestion instead of carding it as a permission", async () => {
    answerWith = () => ({ behavior: "allow" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve",
        arguments: { tool_name: "AskUserQuestion", input: { questions: [{ options: [{ label: "Yes" }] }] } },
      },
    });
    const res = await waitFor(2);
    expect(asks).toHaveLength(0);
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
    expect(resultJson(res).message).toContain("no answerable question");
  });

  it("keeps the good questions when one entry in the same call has no text", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { options: [{ label: "orphaned" }] },
      ],
    };
    answerWith = () => ({
      behavior: "answer",
      message: "The user answered your questions.\n\nQ: Which framework?\nA: React",
      source: "user",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);
    expect(asks[0].input.questions.map((q: { question: string }) => q.question)).toEqual(["Which framework?"]);
    expect(resultJson(res).updatedInput.answers).toEqual({ "Which framework?": "React" });
  });

  it("still brokers an ordinary permission, with the CLI's own rules on allow", async () => {
    answerWith = () => ({ behavior: "allow", always: true });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve",
        arguments: {
          tool_name: "Bash",
          input: { command: "git status" },
          permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
        },
      },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ tool: "Bash", input: { command: "git status" } });
    expect(asks[0].kind).toBeUndefined();
    expect(resultJson(res)).toEqual({
      behavior: "allow",
      updatedInput: { command: "git status" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
  });

  it("hands a large non-ASCII tool input back to the CLI byte for byte", async () => {
    const content = "中文ok€".repeat(150_000);
    answerWith = () => ({ behavior: "allow" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "notes.md", content } } },
    });
    const res = await waitFor(2, 20_000);
    expect(asks[0].input.content === content).toBe(true);
    const updated = resultJson(res).updatedInput.content as string;
    expect(updated.includes("\uFFFD")).toBe(false);
    expect(updated === content).toBe(true);
  }, 30_000);

  it("still asks ask_user as a question and returns the words verbatim", async () => {
    answerWith = () => ({ behavior: "answer", message: "ship it", source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Ready?", choices: ["ship it", "wait"] } },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ kind: "question", tool: "ask_user", input: { question: "Ready?" } });
    expect(res.result.content[0].text).toBe("ship it");
  });

  it("denies every waiting ask when the broker dies", async () => {
    answerWith = () => null;
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "sleep 1" } } },
    });
    await waitForAsks(1);
    for (const conn of conns) conn.destroy();
    const res = await waitFor(2);
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
  });
});
