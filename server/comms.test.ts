import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


import { mentionedBots, normalizeGroupDefaultResponder, roomResponders } from "./store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "comms-test-capability-key-0123456789abcdef";
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe("mentionedBots", () => {
  const peers = [
    { id: "1", name: "New Bot" },
    { id: "2", name: "New Bot 2" },
    { id: "3", name: "Sam" },
    { id: "4", name: "Ghost", hidden: true },
  ];
  it("matches a tag at a word start, case-insensitively", () => {
    expect(mentionedBots("hey @sam, look", peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("@Sam first thing", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("prefers the longest name so prefixes never half-match", () => {
    expect(mentionedBots("ask @New Bot 2 about it", peers).map((b) => b.id)).toEqual(["2"]);
  });
  it("dedupes repeats and collects multiple bots", () => {
    expect(mentionedBots("@Sam and @New Bot and @Sam", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("ignores emails, hidden bots, and mid-word @", () => {
    expect(mentionedBots("mail sam@sam.dev please", peers)).toEqual([]);
    expect(mentionedBots("@Ghost around?", peers)).toEqual([]);
  });
  it("routes Markdown- and punctuation-wrapped mentions", () => {
    expect(mentionedBots("**@Sam** (@New Bot 2) 【@New Bot】", peers).map((bot) => bot.id))
      .toEqual(["3", "2", "1"]);
    expect(mentionedBots("user@Sam /@Sam", peers)).toEqual([]);
  });
  it("requires a word boundary at the end of the name", () => {
    expect(mentionedBots("ask @New Bottle about it", peers)).toEqual([]);
    expect(mentionedBots("@Samo is someone else", peers)).toEqual([]);
    expect(mentionedBots("@Sam𐐀 is someone else", peers)).toEqual([]);
  });
});

describe("roomResponders", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "sam", name: "Sam" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(roomResponders("hello there", members, { kind: "member", botId: "atlas" })).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(roomResponders("@Sam take this", members, { kind: "member", botId: "atlas" })).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomResponders("hello", members, { kind: "everyone" })).toEqual(members);
    expect(roomResponders("hello", members, { kind: "mentions" })).toEqual([]);
    expect(roomResponders("@everyone hello", members, { kind: "mentions" })).toEqual(members);
  });

  it("applies the shared mention boundaries to everyone", () => {
    const mentionsOnly = { kind: "mentions" } as const;
    expect(roomResponders("**@EVERYONE** hello", members, mentionsOnly)).toEqual(members);
    expect(roomResponders("【@everyone】 hello", members, mentionsOnly)).toEqual(members);
    expect(roomResponders("@everyone調査 hello", members, mentionsOnly)).toEqual([]);
    expect(roomResponders("@everyone𐐀 hello", members, mentionsOnly)).toEqual([]);
    expect(roomResponders("user@everyone /@everyone", members, mentionsOnly)).toEqual([]);
  });

  it("keeps bot-to-bot channels on their last-speaker routing", () => {
    expect(normalizeGroupDefaultResponder({ kind: "everyone" }, members.map((member) => member.id), true)).toEqual({
      kind: "mentions",
    });
  });
});

describe("legacy routine comms e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let gateFile = "";
  let stderr = "";

  const waitUntil = async (predicate: () => Promise<boolean>, timeout: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const startRoutine = async (botId: string, text: string) => {
    const created = await api("POST", "/api/routines", {
      name: "Legacy communication fixture",
      prompt: text,
      botId,
      enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    let run: any;
    await waitUntil(async () => {
      run = (await api("GET", "/api/routines")).body.runs.find((candidate: any) => candidate.id === started.body.run.id);
      return Boolean(run?.threadId);
    }, 15_000, "routine execution thread was not created");
    expect((await api("POST", `/api/bots/${botId}/tasks/${run.threadId}`)).status).toBe(200);
    return { status: started.status, body: { run } };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-comms-test-"));
    gateFile = join(home, "helper-gate");
    const antigravityDirectory = join(home, "fake-antigravity");
    const antigravityCli = join(antigravityDirectory, "agy_acp_server.ts");
    const antigravityHarness = join(
      antigravityDirectory,
      process.platform === "win32" ? "localharness_external.exe" : "localharness_external",
    );
    mkdirSync(antigravityDirectory, { recursive: true });
    copyFileSync(FAKE_CLI, antigravityCli);
    copyFileSync(FAKE_CLI, antigravityHarness);
    if (process.platform !== "win32") {
      chmodSync(antigravityCli, 0o755);
      chmodSync(antigravityHarness, 0o755);
    }
    const antigravityProfile = join(
      home,
      ".laterdog",
      "providers",
      "antigravity",
      createHash("sha256").update("geminiAsker").digest("hex"),
      "antigravity-acp",
    );
    mkdirSync(antigravityProfile, { recursive: true });
    writeFileSync(join(antigravityProfile, "acp_token.json"), "{}\n");
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          geminiAsker: {
            driver: "antigravityAgent",
            environment: {
              FAKE_ACP_MODE: "ask-peer",
              FAKE_ACP_AUTH_METHOD: "oauth-personal",
              FAKE_ACP_MODELS: "gemini-3.8-flash-high",
              FAKE_ACP_MODES: "default,yolo",
            },
            config: { cli: antigravityCli, fullAuto: true },
          },
          askerDelegate: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "delegate-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          askerNoLoad: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "delegate-peer",
              FAKE_ACP_LOAD_NULL: "1",
              FAKE_ACP_DUMP: join(home, "asker-no-load.json"),
              FAKE_ACP_DUMP_PROMPT: "1",
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          chiefAsync: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "chief-delegate",
              FAKE_ACP_TASKID_FILE: join(home, "chief-task-id"),
              FAKE_ACP_LOG_FILE: join(home, "chief-fake.log"),
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          chiefCreator: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "create-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          helperCrash: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "exit-early" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          helperImage: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "image" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          helperHang: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "hang" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          helperGate: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          helperPermission: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      LATERDOG_SERVER_PORT: String(PORT),
      LATERDOG_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("seals the internal comms endpoints behind the boot token", async () => {
    const agents = await api("GET", "/api/internal/agents?self=x");
    expect(agents.status).toBe(401);
    const ask = await api("POST", "/api/internal/ask-bot", { toBotId: "x", message: "hi" });
    expect(ask.status).toBe(401);
  });

  it.each([
    { instanceId: "grok", tool: "ask_bot", prefix: "peer error:" },
    { instanceId: "askerDelegate", tool: "delegate_bot", prefix: "delegate error:" },
  ])("reports the removed $tool fixture call in ordinary chat instead of an empty reply", async ({ instanceId, tool, prefix }) => {
    const caller = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${caller.id}`, {
      name: "Outdated fixture",
      section: "Fixture protocol regression",
      modelSelection: { instanceId, model: "fake-model" },
    });
    expect((await api("POST", `/api/bots/${caller.id}/messages`, { text: "Try the old communication fixture." })).status).toBe(202);
    let current: any;
    await waitUntil(async () => {
      current = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === caller.id);
      return !current.busy && current.messages.some((message: any) => message.text?.startsWith(prefix));
    }, 15_000, "the fixture did not surface its protocol error");
    const answer = current.messages.findLast((message: any) => message.role === "bot" && message.kind === "text");
    expect(answer.text).toContain(`Unknown tool: ${tool}`);
    expect(answer.text).toContain("Fixture MCP request failed");
    expect(current.messages.some((message: any) => /^(peer says:|delegated:)\s*$/.test(message.text ?? ""))).toBe(false);
    await api("PATCH", `/api/bots/${caller.id}`, { hidden: true });
  }, 30_000);

  it(
    "carries a question from bot A through the agents proxy to bot B and back",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: selection });

      const send = await startRoutine(asker.id, "hey @Helper ping");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 25_000;
      let askerBot: any;
      for (;;) {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const settled = askerBot.messages.some(
          (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:"),
        );
        if (settled && !askerBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `A never got the peer reply. messages: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(reply.text).toContain("Helper replied:");
      expect(reply.text).toContain("hello from fake acp");

      const note = askerBot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
      expect(note).toBeTruthy();
      expect(note.comm?.groupId).toBeTruthy();
      expect(note.comm?.withName).toBe("Helper");

      const state = (await api("GET", "/api/bots")).body;
      const channel = state.groups.find((g: any) => g.id === note.comm.groupId);
      expect(channel?.dm).toBe(true);
      expect(channel.memberIds).toContain(asker.id);
      expect(channel.memberIds).toContain(helper.id);
      expect(channel.messages.some((m: any) => m.from?.botId === asker.id)).toBe(true);
      expect(channel.messages.some((m: any) => m.from?.botId === helper.id && m.text?.includes("hello from fake acp"))).toBe(true);

      const helperBot = state.bots.find((b: any) => b.id === helper.id);
      const inbound = helperBot.messages.find((m: any) => m.role === "user" && m.kind === "text");
      expect(inbound.text).toContain("[Message from @Asker");
      expect(inbound.text).toContain("ping from fake");
      expect(inbound.peerAsk).toEqual({ botId: asker.id, name: "Asker" });
      const rnote = helperBot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Message from @Asker");
      expect(rnote?.comm?.groupId).toBe(note.comm.groupId);
      expect(helperBot.busy).toBeFalsy();
    },
    40_000,
  );

  it(
    "lets a Gemini Antigravity bot call a peer through the temporary agents MCP mount",
    async () => {
      const section = "Gemini agents MCP e2e";
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Gemini Helper",
        section,
        modelSelection: { instanceId: "grok", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Gemini Asker",
        section,
        modelSelection: { instanceId: "geminiAsker", model: "gemini-3.8-flash-high" },
      });

      const send = await startRoutine(asker.id, "Ask the other bot for a status check.");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 30_000;
      let state: any;
      let askerBot: any;
      let helperBot: any;
      for (;;) {
        state = (await api("GET", "/api/bots")).body;
        askerBot = state.bots.find((bot: any) => bot.id === asker.id);
        helperBot = state.bots.find((bot: any) => bot.id === helper.id);
        const peerReply = askerBot.messages.some(
          (message: any) =>
            message.kind === "text"
            && message.role === "bot"
            && message.text?.includes("peer says: Gemini Helper replied:"),
        );
        const helperReplied = helperBot.messages.some(
          (message: any) =>
            message.kind === "text"
            && message.role === "bot"
            && message.text?.includes("hello from fake acp"),
        );
        if (peerReply && helperReplied && !askerBot.busy && !helperBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `Gemini never got its peer reply. asker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\n`
              + `helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\n`
              + `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const askerReply = askerBot.messages.findLast(
        (message: any) => message.kind === "text" && message.role === "bot",
      );
      expect(askerReply.text).toContain("peer says: Gemini Helper replied:");
      expect(askerReply.text).toContain("hello from fake acp");
      const helperReply = helperBot.messages.findLast(
        (message: any) => message.kind === "text" && message.role === "bot",
      );
      expect(helperReply.text).toContain("hello from fake acp");
      expect(helperReply.text).not.toContain("peer says:");

      const inbound = helperBot.messages.find(
        (message: any) => message.kind === "text" && message.role === "user",
      );
      expect(inbound.text).toContain("[Message from @Gemini Asker");
      expect(inbound.text).toContain("ping from fake");

      expect(existsSync(join(home, ".gemini", "config", "mcp_config.json"))).toBe(false);
    },
    45_000,
  );

  it(
    "lets a section Chief create a safe operator and delegate work to it",
    async () => {
      const chief = (await api("POST", "/api/bots")).body.bot;
      const defaultSelection = chief.modelSelection;
      await api("PATCH", `/api/bots/${chief.id}`, {
        name: "Atlas",
        section: "Launch",
        chiefOfStaff: true,
        modelSelection: { instanceId: "chiefCreator", model: "fake-model" },
      });

      const send = await startRoutine(chief.id, "Create the specialist team and start the design review.");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 30_000;
      let operator: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        operator = state.bots.find((bot: any) => bot.name === "Pixel" && bot.section === "Launch");
        const replied = operator?.messages.some(
          (message: any) => message.role === "bot" && message.text?.includes("hello from fake acp"),
        );
        if (operator && replied && !operator.busy) break;
        if (Date.now() > deadline) {
          throw new Error(`Chief never created and delegated to Pixel. stderr: ${stderr.slice(-2000)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      expect(operator).toMatchObject({
        title: "Product designer",
        description: "Design and review the user experience.",
        section: "Launch",
        approvalMode: "ask",
        autoApprove: false,
        approvePeerComms: false,
        modelSelection: defaultSelection,
      });
      expect(operator.composio).toBe((await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id).composio);
      expect(operator.chiefOfStaff).toBeFalsy();
      expect(operator.messages.some((message: any) => message.text?.includes("Review the new onboarding flow."))).toBe(true);
    },
    45_000,
  );

  it(
    "hands the task off async via delegate_bot and lets B run after A's turn settles",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helperSelection = { instanceId: "grok", model: "fake-model" };
      const askerSelection = { instanceId: "askerDelegate", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: helperSelection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: askerSelection });

      const send = await startRoutine(asker.id, "hey @Helper please pick this up");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 30_000;
      let askerBot: any;
      let helperBot: any;
      let note: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        askerBot = state.bots.find((b: any) => b.id === asker.id);
        helperBot = state.bots.find((b: any) => b.id === helper.id);
        const askerDelegated = askerBot.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.name === "Delegated to @Helper: followup",
        );
        note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        const helperReplied = helperBot.messages.some(
          (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
        );
        const resultReturned = askerBot.messages.some(
          (m: any) =>
            m.role === "bot"
            && m.kind === "text"
            && m.from?.botId === helper.id
            && m.text?.includes("replied to the delegated task")
            && m.text?.includes("hello from fake acp"),
        );
        const woke = askerBot.messages.some(
          (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("woke after delegation"),
        );
        if (askerDelegated && note && helperReplied && resultReturned && woke && !helperBot.busy && !askerBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `delegate handoff never settled. asker busy=${askerBot.busy} helper busy=${helperBot.busy}\n` +
              `asker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\n` +
              `helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const queueAck = askerBot.messages.find(
        (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("delegated:"),
      );
      expect(queueAck.text).not.toContain("hello from fake acp");
      const returnedResult = askerBot.messages.find(
        (m: any) => m.kind === "text" && m.from?.botId === helper.id && m.text?.includes("replied to the delegated task"),
      );
      expect(returnedResult.text).toContain("hello from fake acp");

      expect(note).toBeTruthy();
      expect(note.comm?.groupId).toBeTruthy();
      expect(note.comm?.withName).toBe("Helper");

      const helperInbound = helperBot.messages.find(
        (m: any) => m.role === "user" && m.kind === "text",
      );
      expect(helperInbound.text).toContain("[Delegated by @Asker");
      expect(helperInbound.text).toContain("delegated task");
      expect(helperInbound.text).toContain("[Reason: followup]");
      expect(helperInbound.peerAsk).toEqual({ botId: asker.id, name: "Asker" });
      const helperReply = helperBot.messages.findLast(
        (m: any) => m.kind === "text" && m.role === "bot",
      );
      expect(helperReply.text).toContain("hello from fake acp");

      const state = (await api("GET", "/api/bots")).body;
      const channel = state.groups.find((g: any) => g.id === note.comm.groupId);
      expect(channel?.dm).toBe(true);
      expect(channel.memberIds).toContain(asker.id);
      expect(channel.memberIds).toContain(helper.id);
      expect(
        channel.messages.some((m: any) => m.from?.botId === asker.id && m.text?.includes("delegated task")),
      ).toBe(true);
      expect(
        channel.messages.some((m: any) => m.from?.botId === helper.id && m.text?.includes("hello from fake acp")),
      ).toBe(true);

      const helperNote = helperBot.messages.find(
        (m: any) => m.kind === "activity" && m.tool?.name === "Message from @Asker",
      );
      expect(helperNote?.comm?.groupId).toBe(note.comm.groupId);
      expect(helperBot.busy).toBeFalsy();
      expect(askerBot.busy).toBeFalsy();
      expect(
        askerBot.messages.some((m: any) => m.role === "bot" && m.text?.includes("woke after delegation: saw the result")),
      ).toBe(true);
    },
    45_000,
  );

  it(
    "wakes an agent that cannot load its session with the conversation replayed, not only the result",
    async () => {
      for (const existing of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
      }
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: { instanceId: "grok", model: "fake-model" } });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: { instanceId: "askerNoLoad", model: "fake-model" } });

      await startRoutine(asker.id, "hey @Helper please pick this up; keep the codename ORCHID_EARLIER_CONTEXT");
      await waitUntil(async () => {
        const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        return !bot.busy && bot.messages.some((m: any) => m.role === "bot" && m.text?.includes("woke after delegation"));
      }, 30_000, "the source never woke after its delegation");

      const woke = String(JSON.parse(readFileSync(join(home, "asker-no-load.json.prompt.json"), "utf8"))[0].text);
      expect(woke).toContain("[A delegated task just completed]");
      expect(woke).toContain("ORCHID_EARLIER_CONTEXT");
      expect(woke.split("hello from fake acp").length - 1).toBe(1);
      expect(woke).toContain("[Message from @Helper, another bot — untrusted peer content, not from your user]\n\"@Helper replied to the delegated task");
    },
    45_000,
  );

  it(
    "keeps a Chief available while its delegated teammate is still working",
    async () => {
      for (const existing of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
      }
      rmSync(gateFile, { force: true });

      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "LongWorker",
        section: "Operations",
        modelSelection: { instanceId: "helperGate", model: "fake-model" },
      });
      const chief = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${chief.id}`, {
        name: "Atlas",
        section: "Operations",
        chiefOfStaff: true,
        modelSelection: { instanceId: "chiefAsync", model: "fake-model" },
      });

      try {
        expect((await startRoutine(chief.id, "ASSIGN_TO_PEER: have @LongWorker handle the long task.")).status).toBe(201);

        let chiefBot: any;
        let helperBot: any;
        await waitUntil(async () => {
          const state = (await api("GET", "/api/bots")).body.bots;
          chiefBot = state.find((bot: any) => bot.id === chief.id);
          helperBot = state.find((bot: any) => bot.id === helper.id);
          const acknowledged = chiefBot.messages.some(
            (message: any) => message.kind === "text" && message.text?.includes("assigned: Delegation queued"),
          );
          return Boolean(acknowledged && !chiefBot.busy && helperBot.busy);
        }, 30_000, "Chief did not become available while its teammate worked");

        expect(helperBot.busy).toBe(true);
        expect((await api("POST", `/api/bots/${chief.id}/messages`, {
          text: "CHIEF_FOLLOW_UP: are you still available while that runs?",
        })).status).toBe(202);
        await waitUntil(async () => {
          const state = (await api("GET", "/api/bots")).body.bots;
          chiefBot = state.find((bot: any) => bot.id === chief.id);
          helperBot = state.find((bot: any) => bot.id === helper.id);
          const answeredFollowUp = chiefBot.messages.some(
            (message: any) => message.kind === "text" && message.text?.includes("hello from fake acp"),
          );
          return Boolean(answeredFollowUp && !chiefBot.busy && helperBot.busy);
        }, 20_000, "Chief stayed tied to the delegated worker");

        writeFileSync(gateFile, "go");
        await waitUntil(async () => {
          chiefBot = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id);
          return chiefBot.messages.some(
            (message: any) =>
              message.kind === "text"
              && message.from?.botId === helper.id
              && message.text?.includes("replied to the delegated task")
              && message.text?.includes("long delegated task"),
          );
        }, 20_000, "worker result did not return to the Chief conversation");

        await waitUntil(async () => {
          chiefBot = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id);
          return chiefBot.messages.some(
            (message: any) =>
              message.kind === "text"
              && message.text === "woke after delegation: saw the result",
          );
        }, 20_000, "Chief did not wake with the delegated result");
        expect(chiefBot.busy).toBeFalsy();
      } finally {
        writeFileSync(gateFile, "go");
        await waitUntil(async () => {
          const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === helper.id);
          return !current?.busy;
        }, 10_000, "gated helper did not settle during cleanup").catch(() => {});
        rmSync(gateFile, { force: true });
      }
    },
    60_000,
  );

  it(
    "tells a Chief, and shows it, when its delegated teammate is waiting on an approval",
    async () => {
      for (const existing of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
      }
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Gatekeeper",
        section: "Approvals",
        approvalMode: "ask",
        modelSelection: { instanceId: "helperPermission", model: "fake-model" },
      });
      const chief = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${chief.id}`, {
        name: "Warden",
        section: "Approvals",
        chiefOfStaff: true,
        modelSelection: { instanceId: "chiefAsync", model: "fake-model" },
      });
      const chiefThreads = async () => {
        const tasks = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id).tasks as any[];
        const out: Array<{ threadId: string; messages: any[] }> = [];
        for (const task of tasks) {
          const switched = await api("POST", `/api/bots/${chief.id}/tasks/${task.threadId}`);
          out.push({ threadId: task.threadId, messages: switched.body.bot?.messages ?? [] });
        }
        return out;
      };

      try {
        expect((await startRoutine(chief.id, "ASSIGN_TO_PEER: have @Gatekeeper handle the guarded task.")).status).toBe(201);

        let waitingThreadId = "";
        await waitUntil(async () => {
          const current = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === helper.id);
          waitingThreadId = current?.tasks?.find((task: any) => task.activity === "waiting-on-you")?.threadId ?? "";
          return Boolean(waitingThreadId);
        }, 30_000, "the delegated teammate never stopped on an approval card");

        let chip: any;
        let sourceThreadId = "";
        await waitUntil(async () => {
          for (const thread of await chiefThreads()) {
            const found = thread.messages.find((message: any) =>
              message.kind === "activity" && message.threadRef?.threadId === waitingThreadId);
            if (found) { chip = found; sourceThreadId = thread.threadId; }
          }
          return Boolean(chip);
        }, 10_000, "no waiting-on-approval chip in the Chief's conversation");
        expect(chip.tool.name).toBe("Waiting on your approval in @Gatekeeper");
        expect(chip.threadRef.botId).toBe(helper.id);

        const taskId = readFileSync(join(home, "chief-task-id"), "utf8").trim();
        expect(taskId).toBeTruthy();
        const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-laterdog-test-capability": TEST_CAPABILITY_KEY },
          body: JSON.stringify({ botId: chief.id, threadId: sourceThreadId, kind: "agents" }),
        });
        expect(minted.status).toBe(201);
        const { token } = await minted.json() as { token: string };
        const started = Date.now();
        const status = await fetch(`${BASE}/api/internal/delegations/${taskId}?wait_ms=30000`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(status.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await status.json()).toMatchObject({
          status: "running",
          toBotName: "Gatekeeper",
          awaitingPerson: { kind: "approval", threadTitle: expect.any(String) },
        });

        const card = (await api("POST", `/api/bots/${helper.id}/tasks/${waitingThreadId}`)).body.bot.messages
          .find((message: any) => message.kind === "options" && message.card?.requestId && !message.card.answered);
        expect(card).toBeTruthy();
        const answered = await api("POST", `/api/bots/${helper.id}/respond`, {
          threadId: waitingThreadId, requestId: card.card.requestId, behavior: "allow",
        });
        expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);
        await waitUntil(async () => {
          const thread = (await chiefThreads()).find((candidate) => candidate.threadId === sourceThreadId);
          return Boolean(thread?.messages.some((message: any) =>
            message.id === chip.id && message.tool?.name === "@Gatekeeper got your approval"));
        }, 20_000, "the chip did not settle once the approval was answered");
      } finally {
        await api("POST", `/api/bots/${helper.id}/interrupt`);
        await waitUntil(async () => {
          const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === helper.id);
          return !current?.busy;
        }, 10_000, "approval helper did not settle during cleanup").catch(() => {});
      }
    },
    60_000,
  );

  it(
    "queues an ask_bot to a busy peer as a delegation and delivers it once the peer frees up",
    async () => {
      for (const existing of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
      }
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "GateHelper",
        modelSelection: { instanceId: "helperGate", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "GateAsker",
        modelSelection: { instanceId: "grok", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${helper.id}/messages`, { text: "hold the line" })).status).toBe(202);
      await waitUntil(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === helper.id);
        return Boolean(current?.busy);
      }, 10_000, "helper never went busy");

      expect((await startRoutine(asker.id, "ask @GateHelper something")).status).toBe(201);
      let askerBot: any;
      await waitUntil(async () => {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        return Boolean(reply?.text?.includes("queued as a delegation") && !askerBot.busy);
      }, 25_000, "asker never got the queued-fallback reply");
      const askerReply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(askerReply.text).toContain("Task id:");
      expect(askerReply.text).toContain("delivered to this conversation automatically");
      expect(askerReply.text).not.toContain("wait_delegation");
      expect(askerBot.messages.some(
        (m: any) => m.kind === "activity" && m.tool?.name === "Delegated to @GateHelper: asked while busy",
      )).toBe(true);

      writeFileSync(gateFile, "go");
      let helperBot: any;
      await waitUntil(async () => {
        helperBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === helper.id);
        const delivered = helperBot.messages.some(
          (m: any) => m.role === "user" && m.kind === "text" && m.text?.includes("ping from fake"),
        );
        return Boolean(delivered && !helperBot.busy);
      }, 30_000, "queued message never reached the freed peer");
      const inbound = helperBot.messages.find(
        (m: any) => m.role === "user" && m.kind === "text" && m.text?.includes("ping from fake"),
      );
      expect(inbound.text).toContain("[Delegated by @GateAsker");
      await waitUntil(async () => {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        return askerBot.messages.some(
          (m: any) =>
            m.kind === "text"
            && m.from?.botId === helper.id
            && m.text?.includes("replied to the delegated task")
            && m.text?.includes("ping from fake"),
        );
      }, 10_000, "queued peer reply never returned to the initiating chat");
    },
    60_000,
  );

  it(
    "retries a busy fallback after provider reload without asking for approval twice",
    async () => {
      rmSync(gateFile, { force: true });
      for (const existing of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
      }
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "ReloadHelper",
        modelSelection: { instanceId: "helperGate", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "ReloadAsker",
        modelSelection: { instanceId: "grok", model: "fake-model" },
        approvePeerComms: true,
      });

      expect((await startRoutine(asker.id, "ask @ReloadHelper something")).status).toBe(201);
      let approvalCard: any;
      await waitUntil(async () => {
        const current = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        approvalCard = current.messages.find(
          (m: any) => m.kind === "options" && m.card?.tool === "ask_bot" && !m.card?.answered,
        );
        return Boolean(approvalCard);
      }, 20_000, "initial ask_bot approval card never appeared");

      expect((await api("POST", `/api/bots/${helper.id}/messages`, { text: "hold until reload" })).status).toBe(202);
      await waitUntil(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === helper.id);
        return Boolean(current?.busy);
      }, 10_000, "helper never became busy behind the approval card");
      expect((await api("POST", `/api/bots/${asker.id}/respond`, {
        requestId: approvalCard.card.requestId,
        behavior: "allow",
      })).status).toBe(200);

      await waitUntil(async () => {
        const current = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const queued = current.messages.some(
          (m: any) => m.kind === "text" && m.text?.includes("queued as a delegation"),
        );
        const waiting = current.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.name?.includes("waiting — they're busy"),
        );
        return queued && waiting && !current.busy;
      }, 25_000, "approved ask was not retained as a waiting delegation");

      expect((await api("PUT", "/api/config", { xai: { key: `xai_retry_${Date.now()}` } })).status).toBe(200);
      writeFileSync(gateFile, "go");

      let finalAsker: any;
      await waitUntil(async () => {
        finalAsker = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        return finalAsker.messages.some(
          (m: any) =>
            m.kind === "text"
            && m.from?.botId === helper.id
            && m.text?.includes("replied to the delegated task")
            && m.text?.includes("ping from fake"),
        );
      }, 30_000, "provider reload left the waiting delegation stranded");

      await waitUntil(async () => {
        finalAsker = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        return Boolean(
          finalAsker.messages.some(
            (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("woke after delegation"),
          ) && !finalAsker.busy,
        );
      }, 20_000, "revived asker did not settle without re-asking");

      const approvalCards = finalAsker.messages.filter((m: any) => m.kind === "options");
      expect(approvalCards.filter((m: any) => m.card?.tool === "ask_bot")).toHaveLength(1);
      expect(approvalCards.some((m: any) => m.card?.tool === "delegate_bot")).toBe(false);
    },
    90_000,
  );

  it(
    "converts a timed-out ask into a delegation and delivers the late reply",
    async () => {
      rmSync(gateFile, { force: true });
      for (const existing of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
      }
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "SlowHelper",
        modelSelection: { instanceId: "helperGate", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "SlowAsker",
        modelSelection: { instanceId: "grok", model: "fake-model" },
      });

      expect((await startRoutine(asker.id, "ask @SlowHelper for the numbers")).status).toBe(201);
      let askerBot: any;
      await waitUntil(async () => {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        return Boolean(reply?.text?.includes("converted to a delegation") && !askerBot.busy);
      }, 30_000, "asker never got the timeout-conversion reply");
      const conversionReply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(conversionReply.text).toContain("Task id:");
      expect(conversionReply.text).toContain("after 15 seconds");
      expect((await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === helper.id).busy).toBe(true);
      expect(conversionReply.text).toContain("delivered to this conversation automatically");
      expect(conversionReply.text).not.toContain("wait_delegation");
      expect(askerBot.messages.some(
        (m: any) => m.kind === "activity" && m.tool?.name === "@SlowHelper is still working — ask converted to a delegation",
      )).toBe(true);

      writeFileSync(gateFile, "go");
      await waitUntil(async () => {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        return askerBot.messages.some(
          (m: any) => m.kind === "text" && m.role === "bot"
            && m.text?.includes("replied to the delegated task")
            && m.text?.includes("ping from fake"),
        );
      }, 30_000, "late reply never landed on the asker's thread");
      const helperBot = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === helper.id);
      expect(helperBot.busy).toBeFalsy();
    },
    75_000,
  );

  it(
    "mirrors a successful delegated turn with no text reply as a completed terminal chip",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "helperImage", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await startRoutine(asker.id, "hey @Helper please pick this up");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 30_000;
      let channel: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        channel = note?.comm?.groupId
          ? state.groups.find((g: any) => g.id === note.comm.groupId)
          : undefined;
        const terminal = channel?.messages.some(
          (m: any) =>
            m.from?.botId === helper.id
            && m.kind === "activity"
            && m.tool?.ok === true
            && m.tool?.name === "Delegated turn completed",
        );
        if (terminal) break;
        if (Date.now() > deadline) {
          throw new Error(
            `no completed terminal chip in channel. channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    45_000,
  );

  it(
    "finalizes a delegated turn interrupted by provider reload",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "helperHang", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await startRoutine(asker.id, "hey @Helper please pick this up");
      expect(send.status).toBe(201);

      let channelId: string | undefined;
      const busyDeadline = Date.now() + 30_000;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const helperBot = state.bots.find((b: any) => b.id === helper.id);
        channelId = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        )?.comm?.groupId;
        if (channelId && helperBot.busy) break;
        if (Date.now() > busyDeadline) {
          throw new Error(`delegated hanging turn never started. stderr: ${stderr.slice(-2000)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const reload = await api("PUT", "/api/config", { xai: { key: "xai_reload_test" } });
      expect(reload.status).toBe(200);

      const terminalDeadline = Date.now() + 30_000;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const channel = state.groups.find((g: any) => g.id === channelId);
        const terminal = channel?.messages.filter(
          (m: any) =>
            m.from?.botId === helper.id
            && m.kind === "activity"
            && m.tool?.ok === false
            && m.tool?.name === "Delegated turn did not finish — provider settings changed",
        );
        if (terminal?.length === 1) break;
        if (Date.now() > terminalDeadline) {
          throw new Error(
            `provider reload did not finalize delegation. channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    60_000,
  );

  it(
    "mirrors a crashed delegated turn into the channel as a failed terminal chip",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "helperCrash", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await startRoutine(asker.id, "hey @Helper please pick this up");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 30_000;
      let channel: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        channel = note?.comm?.groupId
          ? state.groups.find((g: any) => g.id === note.comm.groupId)
          : undefined;
        const terminal = channel?.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.ok === false && /did not finish — .+/.test(m.tool?.name ?? ""),
        );
        if (terminal) break;
        if (Date.now() > deadline) {
          throw new Error(
            `no failed terminal chip in channel. channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(
        channel.messages.some((m: any) => m.from?.botId === asker.id && m.text?.includes("delegated task")),
      ).toBe(true);
    },
    45_000,
  );

  it(
    "mirrors a delegation that could not start into the channel",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "missing-instance", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await startRoutine(asker.id, "hey @Helper please pick this up");
      expect(send.status).toBe(201);

      const deadline = Date.now() + 30_000;
      let channel: any;
      let sourceChip: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        sourceChip = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.ok === false && m.tool?.name?.includes("could not start"),
        );
        channel = note?.comm?.groupId
          ? state.groups.find((g: any) => g.id === note.comm.groupId)
          : undefined;
        const terminal = channel?.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.ok === false && m.tool?.name?.includes("could not start"),
        );
        if (sourceChip && terminal) break;
        if (Date.now() > deadline) {
          throw new Error(
            `could-not-start not mirrored. sourceChip=${JSON.stringify(sourceChip)}\n` +
              `channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    45_000,
  );

  it(
    "blocks ask_bot behind a card and only runs B after the user allows",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      const approval = await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: selection,
        approvePeerComms: true,
      });
      expect(approval.status).toBe(200);
      expect(approval.body.bot.approvePeerComms).toBe(true);

      const send = await startRoutine(asker.id, "hey @Helper needs approval");
      expect(send.status).toBe(201);

      let askerBot: any;
      let helperBot: any;
      let card: any;
      const cardDeadline = Date.now() + 20_000;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        askerBot = state.bots.find((b: any) => b.id === asker.id);
        helperBot = state.bots.find((b: any) => b.id === helper.id);
        card = askerBot.messages.find(
          (m: any) => m.kind === "options" && m.card?.requestId && m.card?.tool === "ask_bot",
        );
        const helperStarted =
          helperBot.messages.some((m: any) => m.role === "user" && m.kind === "text") ||
          helperBot.busy;
        if (card && !helperStarted) break;
        if (Date.now() > cardDeadline) {
          throw new Error(
            `approval card never appeared or B started anyway\n` +
              `asker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\n` +
              `helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(card.card.allowKey).toBe(`ask_bot:${helper.id}`);
      expect(card.card.options).toEqual(["Allow", "Deny", "Always allow"]);
      expect(card.card.title).toContain("@Asker");
      expect(card.card.title).toContain("@Helper");

      const allow = await api(
        "POST",
        `/api/bots/${asker.id}/respond`,
        { requestId: card.card.requestId, behavior: "allow" },
      );
      expect(allow.status).toBe(200);

      const settledDeadline = Date.now() + 25_000;
      let finalAsker: any;
      let finalHelper: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        finalAsker = state.bots.find((b: any) => b.id === asker.id);
        finalHelper = state.bots.find((b: any) => b.id === helper.id);
        const peerFolded = finalAsker.messages.findLast(
          (m: any) => m.kind === "text" && m.role === "bot",
        )?.text?.includes("peer says:");
        const helperReplied = finalHelper.messages.some(
          (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
        );
        if (peerFolded && helperReplied && !finalHelper.busy && !finalAsker.busy) break;
        if (Date.now() > settledDeadline) {
          throw new Error(
            `B never ran after allow\n` +
              `asker tail: ${JSON.stringify(finalAsker.messages.slice(-8))}\n` +
              `helper tail: ${JSON.stringify(finalHelper.messages.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    60_000,
  );

  it("refuses ask_bot with a denial chip and never starts B when the user denies", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const selection = { instanceId: "grok", model: "fake-model" };
    const helper = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
    const asker = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${asker.id}`, {
      name: "Asker",
      modelSelection: selection,
      approvePeerComms: true,
    });

    const send = await startRoutine(asker.id, "hey @Helper do not allow");
    expect(send.status).toBe(201);

    let askerBot: any;
    let helperBot: any;
    let card: any;
    const cardDeadline = Date.now() + 20_000;
    for (;;) {
      const state = (await api("GET", "/api/bots")).body;
      askerBot = state.bots.find((b: any) => b.id === asker.id);
      helperBot = state.bots.find((b: any) => b.id === helper.id);
      card = askerBot.messages.find(
        (m: any) => m.kind === "options" && m.card?.requestId && m.card?.tool === "ask_bot",
      );
      if (card) break;
      if (Date.now() > cardDeadline) {
        throw new Error(
          `deny test: card never appeared\nasker tail: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const deny = await api(
      "POST",
      `/api/bots/${asker.id}/respond`,
      { requestId: card.card.requestId, behavior: "deny" },
    );
    expect(deny.status).toBe(200);

    const settledDeadline = Date.now() + 20_000;
    for (;;) {
      const state = (await api("GET", "/api/bots")).body;
      askerBot = state.bots.find((b: any) => b.id === asker.id);
      helperBot = state.bots.find((b: any) => b.id === helper.id);
      const finalText = askerBot.messages.findLast(
        (m: any) => m.role === "bot" && m.kind === "text" && m.text,
      );
      if (finalText?.text?.includes("the person said no") && !askerBot.busy) break;
      if (Date.now() > settledDeadline) {
        throw new Error(
          `deny test: denial didn't reach A\nasker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\nstderr: ${stderr.slice(-2000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(helperBot.busy).toBeFalsy();
    expect(
      helperBot.messages.some((m: any) => m.role === "user" && m.kind === "text"),
    ).toBe(false);
    expect(
      helperBot.messages.some(
        (m: any) =>
          m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
      ),
    ).toBe(false);
  }, 50_000);

  it("does not inject the agents integration into a depth-1 turn", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const selection = { instanceId: "grok", model: "fake-model" };
    const askerSelection = { instanceId: "askerDelegate", model: "fake-model" };
    const helper = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
    const asker = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: askerSelection });

    const send = await startRoutine(asker.id, "delegate this to @Helper please");
    expect(send.status).toBe(201);

    const deadline = Date.now() + 30_000;
    let helperBot: any;
    for (;;) {
      const state = (await api("GET", "/api/bots")).body;
      helperBot = state.bots.find((b: any) => b.id === helper.id);
      const reply = helperBot.messages.find(
        (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
      );
      if (reply && !helperBot.busy) break;
      if (Date.now() > deadline) {
        throw new Error(
          `B never replied. helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const reply = helperBot.messages.findLast(
      (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
    );
    expect(reply.text).toContain("hello from fake acp");
    expect(reply.text).not.toContain("one hop");
    expect(reply.text).not.toContain("peer error");
  }, 45_000);
});
