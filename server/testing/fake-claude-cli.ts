#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ON_IT_NOTE } from "../laterdog/work-updates.ts";
import { createPuppies } from "./fake-claude-puppies.ts";
import { runRoomHandoffAgent } from "./room-handoff-agent.ts";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

{
  const spawner = process.ppid;
  const orphanWatch = setInterval(() => {
    if (process.ppid !== spawner) process.exit(0);
    try { process.kill(spawner, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") process.exit(0);
    }
  }, 500);
  orphanWatch.unref();
}
{
  const exitDelay = Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS);
  if (Number.isFinite(exitDelay) && exitDelay > 0) {
    process.on("SIGTERM", () => { setTimeout(() => process.exit(0), exitDelay); });
  }
}
const scriptedReplies = (() => {
  try {
    const parsed = JSON.parse(process.env.FAKE_CLAUDE_REPLIES ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string | string[] =>
      typeof value === "string" || (Array.isArray(value) && value.every((part) => typeof part === "string"))
    );
  } catch {
    return [];
  }
})();
type ScriptedToolCall = { name: string; id?: string; input: Record<string, unknown>; ok: boolean; output?: unknown; pending?: boolean };
const scriptedToolCalls: ScriptedToolCall[] | null = (() => {
  const raw = process.env.FAKE_CLAUDE_TOOL_CALLS;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((call): call is { name: string; id?: unknown; input?: unknown; ok?: unknown; output?: unknown; pending?: unknown } => typeof call?.name === "string")
      .map((call) => ({
        name: call.name,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        input: call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {},
        ok: call.ok !== false,
        output: call.output,
        ...(call.pending === true ? { pending: true } : {}),
      }));
  } catch {
    return null;
  }
})();
let toolUseCount = 0;
let scriptedReplyIndex = 0;
const nextScriptedReply = (): string[] => {
  const stateFile = process.env.FAKE_CLAUDE_REPLY_STATE;
  let index = scriptedReplyIndex;
  if (stateFile) {
    try {
      index = Number(readFileSync(stateFile, "utf8")) || 0;
    } catch {}
    writeFileSync(stateFile, String(index + 1));
  } else {
    scriptedReplyIndex += 1;
  }
  const reply = scriptedReplies[index] ?? "hello from fake claude";
  return Array.isArray(reply) ? reply : [reply];
};

const argv = process.argv.slice(2);
const settingsHooks: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>> = (() => {
  if (process.env.FAKE_CLAUDE_HOOKS !== "1") return {};
  const i = argv.indexOf("--settings");
  if (i === -1) return {};
  try {
    const parsed = JSON.parse(readFileSync(argv[i + 1]!, "utf8"));
    return parsed && typeof parsed.hooks === "object" ? parsed.hooks : {};
  } catch {
    return {};
  }
})();
function runHooks(event: string, payload: Record<string, unknown>): string {
  let stdout = "";
  for (const entry of settingsHooks[event] ?? []) {
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== "command" || !hook.command) continue;
      const result = spawnSync(hook.command, {
        shell: true,
        input: JSON.stringify({ hook_event_name: event, session_id: "fake-session", cwd: process.cwd(), ...payload }),
        env: process.env,
        timeout: ((hook.timeout ?? 5) + 1) * 1000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      });
      stdout += result.stdout ?? "";
    }
  }
  return stdout;
}
let turnsPlayed = 0;
let resumedErrorPlayed = false;
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

const probe = argv[0] === "--version" ? "version" : argv[0] === "--help" ? "help" : argv[0] === "auth" && argv[1] === "status" ? "auth" : null;
if (probe) {
  if (process.env.FAKE_CLAUDE_PROBE_LOG) appendFileSync(process.env.FAKE_CLAUDE_PROBE_LOG, `${probe} ${process.pid}\n`);
  const hold = process.env[`FAKE_CLAUDE_HOLD_${probe.toUpperCase()}`];
  while (hold && !existsSync(hold)) await new Promise((resolve) => setTimeout(resolve, 20));
}

if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.232"} (Claude Code)\n`);
  process.exit(0);
}

if (argv[0] === "--help") {
  const [maj = 0, min = 0, pat = 0] = (process.env.FAKE_CLAUDE_VERSION ?? "2.1.232").split(".").map(Number);
  const has = process.env.FAKE_CLAUDE_AUTOCOMPACT !== "0" && (maj > 2 || (maj === 2 && (min > 1 || (min === 1 && pat >= 122))));
  process.stdout.write(
    `Usage: claude [options]\n\nOptions:\n  --model <model>  Model\n${has ? "  --autocompact <tokens>  Compaction window\n" : ""}  -h, --help  Display help\n`,
  );
  process.exit(0);
}

if (argv[0] === "update") {
  if (process.env.FAKE_CLAUDE_UPDATE === "fail") {
    process.stderr.write("fake-claude: simulated update failure\n");
    process.exit(1);
  }
  process.stdout.write("Claude Code is up to date.\n");
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

if (["text", "json"].includes(argAfter("--output-format") ?? "")) {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  const upkeepCall = /You are the (?:CAPTURE|TIDY|ORGANIZE) step of a memory system/.test(prompt);
  const oneShotDump = process.env.FAKE_CLAUDE_TEXT_DUMP ?? (upkeepCall ? undefined : process.env.FAKE_CLAUDE_DUMP);
  if (oneShotDump) {
    writeFileSync(
      oneShotDump,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig: null }, null, 2),
    );
  }
  if (process.env.FAKE_CLAUDE_TEXT_HANG) {
    await new Promise(() => setInterval(() => {}, 1 << 30));
  }
  const replyText = (text: string, code = 0) => {
    const model = argAfter("--model") ?? "claude-haiku-4-5";
    process.stdout.write(argAfter("--output-format") === "json"
      ? process.env.FAKE_CLAUDE_TEXT_RESULT ?? JSON.stringify({
          type: "result", is_error: code !== 0, result: text,
          usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 5 },
          total_cost_usd: 0.01,
          modelUsage: { [model]: { inputTokens: 10, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 5, costUSD: 0.01 } },
        })
      : code === 0 ? text : "");
    process.exit(code);
  };
  if (process.env.FAKE_CLAUDE_TEXT_ROUTES && existsSync(process.env.FAKE_CLAUDE_TEXT_ROUTES)) {
    try {
      const routes = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_TEXT_ROUTES, "utf8")) as Record<string, string>;
      const hit = Object.entries(routes).find(([marker]) => prompt.includes(marker));
      if (hit) {
        replyText(hit[1]);
      }
    } catch {}
  }
  if (process.env.FAKE_CLAUDE_TEXT_FILE) {
    const file = process.env.FAKE_CLAUDE_TEXT_FILE;
    const reply = existsSync(file) ? readFileSync(file, "utf8") : "__FAIL__";
    if (reply.trim() === "__FAIL__") {
      process.stderr.write("fake one-shot text failed\n");
      replyText("fake one-shot text failed", 1);
    }
    replyText(reply);
  }
  replyText("fake generated text\n");
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
const model = argAfter("--model") ?? "claude-fake";
const requestedPermissionMode = argAfter("--permission-mode") ?? "default";
const autoUnavailableFor = (process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS ?? "").split(",").filter(Boolean);
const permissionMode =
  requestedPermissionMode === "auto" && autoUnavailableFor.includes(model) ? "default" : requestedPermissionMode;
const toolsFlag = argAfter("--tools");
const tools = [...new Set([...(toolsFlag ? toolsFlag.split(",") : ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]),
  ...(process.env.FAKE_CLAUDE_KEEP_BASH === "1" ? ["Bash"] : [])])];
let launchFiles: Record<string, unknown> | null = null;
let turnRunning = false;
let steered: string[] = [];
let steeredMessages: JsonValue[] = [];
const replayUserMessages = argv.includes("--replay-user-messages");
let replayCount = 0;
const replay = (sent: JsonValue) => {
  if (!replayUserMessages) return;
  const message = (sent ?? {}) as { uuid?: unknown; message?: unknown };
  const uuid = typeof message.uuid === "string" ? message.uuid : `fake-replay-${process.pid}-${++replayCount}`;
  out({ type: "user", message: message.message ?? null, uuid, session_id: sessionId, parent_tool_use_id: null, isReplay: true });
};
const replaySteered = () => {
  for (const message of steeredMessages.splice(0)) replay(message);
};
const lateSteers: JsonValue[] = [];
let lateContinuation = false;
let lateTurnWaiting = false;
type FakeModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number };
const costStateFile = process.env.FAKE_CLAUDE_COST_STATE ? join(process.env.FAKE_CLAUDE_COST_STATE, `${sessionId}.json`) : null;
const runningCost: { total: number; modelUsage: Record<string, FakeModelUsage> } = (() => {
  if (costStateFile && argv.includes("--resume")) {
    try {
      return JSON.parse(readFileSync(costStateFile, "utf8"));
    } catch {}
  }
  return { total: 0, modelUsage: {} };
})();
let stdinEnded = false;
let steerGateArmed = false;

const armSteerGate = () => {
  const gate = process.env.FAKE_CLAUDE_STEER_GATE;
  if (!gate || steerGateArmed) return;
  steerGateArmed = true;
  process.stdin.pause();
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    process.stdin.resume();
  }, 10);
};

const personWords = (text: string): string => text.endsWith(`\n\n${ON_IT_NOTE}`) ? text.slice(0, -(ON_IT_NOTE.length + 2)) : text;

const promptText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  return typeof m?.content === "string" ? personWords(m.content) : "";
};

const steerText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  if (!Array.isArray(m?.content)) return promptText(prompt);
  return m.content
    .map((block: { type?: string; text?: string; source?: { media_type?: string } }) =>
      block?.type === "text" ? block.text ?? "" : block?.type === "image" ? `[image ${block.source?.media_type ?? "unknown"}]` : "")
    .filter(Boolean)
    .join(" ");
};

const startLateTurn = (): boolean => {
  if (lateTurnWaiting) return true;
  const late = lateSteers[0];
  if (late === undefined) return false;
  const initGate = process.env.FAKE_CLAUDE_LATE_STEER_INIT_GATE;
  if (initGate && !existsSync(initGate)) {
    lateTurnWaiting = true;
    const poll = setInterval(() => {
      if (!existsSync(initGate)) return;
      clearInterval(poll);
      lateTurnWaiting = false;
      finishIfDone();
    }, 10);
    return true;
  }
  lateSteers.shift();
  playTurn(late, true);
  return true;
};

const finishIfDone = () => {
  if (turnRunning) return;
  if (startLateTurn()) return;
  if (stdinEnded) process.exit(0);
  if (process.env.FAKE_CLAUDE_EXIT_AFTER_TURN === "1") process.stdout.write("", () => process.exit(0));
  const gone = process.env.FAKE_CLAUDE_GONE_AFTER_TURN;
  if (gone) process.stdout.write("", () => {
    process.stdin.pause();
    closeSync(0);
    writeFileSync(`${gone}.closed`, "closed");
    setInterval(() => { if (existsSync(gone)) process.exit(0); }, 10);
  });
};

const finishTurn = () => {
  runHooks("Stop", { stop_hook_active: false });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
  turnRunning = false;
  finishIfDone();
};

const readLaunchFiles = (): Record<string, unknown> => {
  const configPath = argAfter("--mcp-config");
  let mcpConfig: unknown = null;
  if (configPath) {
    try {
      mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {}
  }
  const systemPromptPath = argAfter("--append-system-prompt-file");
  const settingsPath = argAfter("--settings");
  const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : null;
  const settingsMode = settingsPath ? statSync(settingsPath).mode & 0o777 : null;
  let systemPrompt: string | null = null;
  if (systemPromptPath) {
    try {
      systemPrompt = readFileSync(systemPromptPath, "utf8");
    } catch {}
  }
  return { systemPrompt, mcpConfig, settings, settingsMode };
};

const ASKS_FOR_SCREEN = /\b(computer|desktop|screen|screenshot|chrome|browser)\b/i;

const useCloudComputer = () => {
  launchFiles ??= readLaunchFiles();
  const server = (launchFiles.mcpConfig as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> } | null)
    ?.mcpServers?.computer;
  if (!server?.command || server.args?.at(-1) !== "computer" || !/harness-mcp-proxy/.test(server.args[0] ?? "")) return;
  const id = `tu-${process.pid}-${++toolUseCount}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__computer__screenshot", input: {} }] } });
  const ran = spawnSync(server.command, server.args, {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } })}\n`,
    env: { ...process.env, ...server.env }, encoding: "utf8", timeout: 150_000,
  });
  let reply: { result?: { isError?: boolean; content?: unknown }; error?: { message?: string } } = {};
  try { reply = JSON.parse(ran.stdout.trim().split("\n")[0] ?? ""); } catch { reply = { error: { message: ran.stderr || "no answer" } }; }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id,
    is_error: Boolean(reply.error || reply.result?.isError), content: reply.result?.content ?? reply.error?.message ?? "" }] } });
};

const playPuppies = createPuppies({
  out,
  init: () => out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools }),
  endTurn: () => {
    turnRunning = false;
    finishIfDone();
  },
  sessionId,
  model,
});

const playTurn = async (prompt: JsonValue, late = false) => {
  turnRunning = true;
  lateContinuation = late;
  steered = [];
  steeredMessages = [];
  if (process.env.FAKE_CLAUDE_PROMPTS) appendFileSync(process.env.FAKE_CLAUDE_PROMPTS, `${JSON.stringify(prompt)}\n`);
  if (!late && process.env.FAKE_CLAUDE_DUMP) {
    launchFiles ??= readLaunchFiles();
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt, ...launchFiles }, null, 2),
    );
  }

  if (process.env.FAKE_CLAUDE_ROUTER_PING === "1" && process.env.ANTHROPIC_BASE_URL) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
    if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
    spawnSync(process.execPath, [
      "-e",
      "fetch(process.argv[1], { method: 'POST', headers: JSON.parse(process.argv[2]), body: '{}' }).then((r) => r.text(), () => {})",
      `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/u, "")}/v1/messages`,
      JSON.stringify(headers),
    ], { stdio: "ignore", timeout: 5_000 });
  }

  if (mode === "dead-session" && argv.includes("--resume")) {
    process.stderr.write(`fake-claude: No conversation found with session ID: ${argAfter("--resume")}\n`);
    process.exit(1);
  }

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }
  if (process.env.FAKE_CLAUDE_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
    let launched = 0;
    try {
      launched = Number(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) || 0;
    } catch {}
    const quota = Number(process.env.FAKE_CLAUDE_TRANSIENTS) || 0;
    writeFileSync(process.env.FAKE_CLAUDE_STATE, String(launched + 1));
    out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools });

  if (lateContinuation && process.env.FAKE_CLAUDE_LATE_STEER_SILENT) {
    setInterval(() => {}, 1_000);
    return;
  }
  replay(prompt);

  if (mode === "resume-dies-after-init" && argv.includes("--resume")) {
    process.stderr.write("fake-claude: simulated crash after accepting the resumed session\n");
    process.exit(3);
  }

  const refreshLockFails = Number(process.env.FAKE_CLAUDE_REFRESH_LOCK_FAILS) || 0;
  const refreshLockState = process.env.FAKE_CLAUDE_REFRESH_LOCK_STATE;
  if (refreshLockFails > 0 && refreshLockState) {
    let failed = 0;
    try {
      failed = Number(readFileSync(refreshLockState, "utf8")) || 0;
    } catch {}
    if (failed < refreshLockFails) {
      writeFileSync(refreshLockState, String(failed + 1));
      const text = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";
      out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, error: "server_error", is_api_error_message: true });
      out({ type: "result", subtype: "success", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", result: text });
      turnRunning = false;
      finishIfDone();
      return;
    }
  }

  const resumedError = process.env.FAKE_CLAUDE_RESUMED_API_ERROR === "1" && argv.includes("--resume") && !resumedErrorPlayed;
  if (resumedError) resumedErrorPlayed = true;
  if (mode === "api-error" || resumedError) {
    const text = process.env.FAKE_CLAUDE_API_ERROR ?? "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
    out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, error: "unknown", is_api_error_message: true });
    out({ type: "result", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", result: text });
    turnRunning = false;
    finishIfDone();
    return;
  }

  const usageGate = process.env.FAKE_CLAUDE_USAGE_LIMIT_GATE;
  if (mode === "usage-limit" && (!usageGate || existsSync(usageGate))) {
    const release = process.env.FAKE_CLAUDE_USAGE_LIMIT_RELEASE;
    while (release && !existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20));
    replaySteered();
    if (process.env.FAKE_CLAUDE_USAGE_LIMIT_ROOM_PLAN) {
      await runRoomHandoffAgent(argv, process.env.FAKE_CLAUDE_USAGE_LIMIT_ROOM_PLAN, prompt);
    }
    if (process.env.FAKE_CLAUDE_USAGE_LIMIT_AFTER_TOOL === "1") {
      const id = `tu-${process.pid}-${++toolUseCount}`;
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo started" } }] } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text: "started" }] }] } });
    }
    const resetsIn = Number(process.env.FAKE_CLAUDE_USAGE_RESETS_IN);
    const resetsAt = Number(process.env.FAKE_CLAUDE_USAGE_RESETS_AT) ||
      (resetsIn > 0 ? Math.ceil(Date.now() / 1000 + resetsIn) : Math.ceil(Date.now() / 3_600_000 + 1) * 3_600);
    const hour = new Date(resetsAt * 1000).getUTCHours();
    const text = process.env.FAKE_CLAUDE_USAGE_LIMIT ??
      `You've hit your session limit · resets ${hour % 12 || 12}${hour < 12 ? "am" : "pm"} (UTC)`;
    const info = { status: "rejected", rateLimitType: "five_hour", resetsAt };
    out({ type: "rate_limit_event", rate_limit_info: info, uuid: `fake-rate-limit-${process.pid}`, session_id: sessionId });
    out({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text }] },
      error: "rate_limit", is_api_error_message: true,
      api_error: "usage_limit_reached", api_error_params: { rate_limit_info: info },
    });
    if (process.env.FAKE_CLAUDE_USAGE_LIMIT_NO_RESULT === "1") {
      process.stdout.write("", () => process.exit(1));
      return;
    }
    out({ type: "result", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", result: text });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "puppies") {
    playPuppies(steerText(prompt));
    return;
  }

  if (process.env.FAKE_CLAUDE_ROOM_PLAN) {
    const progress = (text: string) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    void runRoomHandoffAgent(argv, process.env.FAKE_CLAUDE_ROOM_PLAN, prompt, undefined, progress).then(text => {
      const contextTokens = Number(process.env.FAKE_CLAUDE_CONTEXT_TOKENS);
      const usage = Number.isSafeInteger(contextTokens) && contextTokens > 0 ? { input_tokens: contextTokens, output_tokens: 5 } : undefined;
      out({ type: "assistant", message: { content: [{ type: "text", text }], ...(usage ? { usage } : {}) } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    }).catch(error => {
      out({ type: "result", is_error: true, result: String(error), stop_reason: "error" });
    }).finally(() => { turnRunning = false; finishIfDone(); });
    return;
  }

  if (mode === "hang") {
    const release = process.env.FAKE_CLAUDE_RELEASE;
    const finishGate = process.env.FAKE_CLAUDE_FINISH_GATE;
    const held = setInterval(() => {
      if (finishGate && existsSync(finishGate)) {
        clearInterval(held);
        out({ type: "assistant", message: { content: [{ type: "text", text: "fixture turn completed" }] } });
        finishTurn();
        return;
      }
      if (!release || !existsSync(release)) return;
      clearInterval(held);
      out({ type: "assistant", message: { content: [{ type: "text", text: "released" }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
      turnRunning = false;
      finishIfDone();
    }, finishGate ? 10 : 100);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  if (mode === "not-logged-in") {
    out({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in \u00b7 Please run /login" }] },
      error: "authentication_failed",
      is_api_error_message: true,
    });
    out({
      type: "result",
      is_error: true,
      stop_reason: "stop_sequence",
      terminal_reason: "api_error",
      result: "Not logged in \u00b7 Please run /login",
    });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  if (process.env.FAKE_CLAUDE_USES_CLOUD_COMPUTER === "1" && ASKS_FOR_SCREEN.test(steerText(prompt))) useCloudComputer();

  let replyParts = nextScriptedReply();
  const defaultToolId = `tu-${process.pid}-${++toolUseCount}`;
  if (process.env.FAKE_CLAUDE_TURN_STATE) {
    let n = 0;
    try { n = Number(readFileSync(process.env.FAKE_CLAUDE_TURN_STATE, "utf8")) || 0; } catch {}
    turnsPlayed = n;
    writeFileSync(process.env.FAKE_CLAUDE_TURN_STATE, String(n + 1));
  }
  turnsPlayed += 1;
  if (process.env.FAKE_CLAUDE_COMPACT === "1" && turnsPlayed >= 2) {
    runHooks("PreCompact", { trigger: "auto" });
    const context = runHooks("SessionStart", { source: "compact" });
    if (context.trim()) replyParts = [`${context.trim()}\n\n${replyParts[0] ?? ""}`, ...replyParts.slice(1)];
  }
  const usage = { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 };
  if (scriptedToolCalls) {
    for (const call of scriptedToolCalls) {
      const id = call.id ?? `tu-${process.pid}-${++toolUseCount}`;
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: call.name, input: call.input }], usage } });
      if (call.pending) continue;
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !call.ok, content: call.output }] } });
      runHooks("PostToolUse", { tool_name: call.name, tool_input: call.input, tool_response: call.output, tool_use_id: id });
    }
    if (!scriptedToolCalls.some((call) => call.pending)) for (const text of replyParts) out({ type: "assistant", message: { content: [{ type: "text", text }], usage } });
  } else {
    replyParts.forEach((text, index) => {
      const content: Array<
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      > = [{ type: "text", text }];
      if (index === replyParts.length - 1) content.push({ type: "tool_use", id: defaultToolId, name: "Bash", input: { command: "echo hi" } });
      out({ type: "assistant", message: { content, usage } });
    });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: defaultToolId, is_error: false, content: [{ type: "text", text: "hi" }] }] } });
    runHooks("PostToolUse", { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: "hi", tool_use_id: defaultToolId });
  }

  const finish = () => {
    replaySteered();
    runHooks("Stop", { stop_hook_active: false });
    runningCost.total = Number((runningCost.total + 0.01).toFixed(2));
    const counted = (runningCost.modelUsage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 });
    counted.inputTokens += 10;
    counted.cacheReadInputTokens += 2;
    counted.outputTokens += 5;
    counted.costUSD = Number((counted.costUSD + 0.01).toFixed(2));
    if (costStateFile) writeFileSync(costStateFile, JSON.stringify(runningCost));
    const queued = process.env.FAKE_CLAUDE_QUEUED_TURN_COUNT;
    out({
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: runningCost.total,
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
      modelUsage: runningCost.modelUsage,
      ...(queued === "zero" ? { queued_turn_count: 0 } : queued === "count" ? { queued_turn_count: lateSteers.length } : {}),
    });
    turnRunning = false;
    finishIfDone();
  };
  if (mode === "background-result") {
    out({ type: "result", origin: { kind: "task-notification" }, is_error: false, total_cost_usd: 99 });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "parent still working" } } });
    const poll = setInterval(() => {
      if (!process.env.FAKE_CLAUDE_FINISH_GATE || !existsSync(process.env.FAKE_CLAUDE_FINISH_GATE)) return;
      clearInterval(poll);
      finish();
    }, 10);
    return;
  }
  if (mode === "slow") {
    const finishSlowTurn = () => {
      if (process.env.FAKE_CLAUDE_SLOW_TAIL_TOOL) {
        const id = `tu-${process.pid}-${++toolUseCount}`;
        out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo tail" } }] } });
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text: "tail" }] }] } });
      }
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      replaySteered();
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      finish();
    };
    const finishGate = lateContinuation ? process.env.FAKE_CLAUDE_LATE_STEER_GATE : process.env.FAKE_CLAUDE_SLOW_FINISH_GATE;
    if (finishGate) {
      const poll = setInterval(() => {
        if (!existsSync(finishGate)) return;
        clearInterval(poll);
        setImmediate(finishSlowTurn);
      }, 10);
    } else {
      setTimeout(finishSlowTurn, 800);
    }
  } else {
    finish();
  }
};

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let prompt: JsonValue = null;
    try {
      prompt = JSON.parse(line);
    } catch {
      continue;
    }
    if (turnRunning || lateTurnWaiting) {
      if (process.env.FAKE_CLAUDE_LATE_STEER_GATE) lateSteers.push(prompt);
      else {
        steered.push(steerText(prompt));
        steeredMessages.push(prompt);
      }
      if (process.env.FAKE_CLAUDE_STEER_RECEIVED) writeFileSync(process.env.FAKE_CLAUDE_STEER_RECEIVED, "received");
    } else {
      playTurn(prompt);
      armSteerGate();
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  finishIfDone();
});
