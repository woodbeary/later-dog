#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";

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
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const models = (process.env.FAKE_ACP_MODELS_FILE && existsSync(process.env.FAKE_ACP_MODELS_FILE)
  ? readFileSync(process.env.FAKE_ACP_MODELS_FILE, "utf8")
  : process.env.FAKE_ACP_MODELS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const defaultModelEnv = process.env.AGY_ACP_DEFAULT_MODEL;
if (models.length && defaultModelEnv && !models.includes(defaultModelEnv)) models.push(defaultModelEnv);
let currentModel: string | null = models.length && defaultModelEnv ? defaultModelEnv : models[0] ?? null;
const variantConfigs: Record<string, { id?: string; currentValue?: string; options: any[] }> =
  JSON.parse(process.env.FAKE_ACP_VARIANTS ?? "{}");
let currentVariant = variantConfigs[currentModel ?? ""]?.currentValue;
const variantValues = (entries: any[]): string[] => entries.flatMap((entry) => (
  typeof entry?.value === "string" ? [entry.value] : Array.isArray(entry?.options) ? variantValues(entry.options) : []
));
const modes = (process.env.FAKE_ACP_MODES ?? "").split(",").filter(Boolean);
let currentMode: string | null = modes[0] ?? null;
const rejectLiveLoadFile = process.env.FAKE_ACP_REJECT_LIVE_LOAD_FILE ?? "";
const configOptions = () => {
  const variant = variantConfigs[currentModel ?? ""];
  const options = [
    ...(models.length ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
      ] : []),
    ...(variant ? [{
      id: variant.id ?? "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: currentVariant,
      options: variant.options,
    }] : []),
    ...(modes.length ? [{
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: modes.map((value) => ({ value, name: value })),
    }] : []),
  ];
  return options.length ? options : null;
};
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [modelId, name] = entry.split("|");
    return name ? { modelId, name } : { modelId };
  });
const sessionModels = () =>
  acpModels.length ? { currentModelId: acpModels[0].modelId, availableModels: acpModels } : null;

const argv = process.argv.slice(2);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_IMAGE_CAPABILITY",
    "FAKE_ACP_DUMP_PROMPT",
    "TEST_POLICY",
    "OPENCODE_API_KEY",
    "OPENCODE_PERMISSION",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GROK_AGENT",
    "BOX_TOKEN",
    "LATERDOG_TTS_KEY",
    "LATERDOG_FISH_AUDIO_API_KEY",
    "LATERDOG_CLOUD_READY_TOKEN",
    "LATERDOG_CLOUD_BOOTSTRAP",
    "LATERDOG_LICENSE_KEY",
    "LATERDOG_INSTALLATION_CREDENTIAL",
    "FACTORY_API_KEY",
    "UNSLOTH_STUDIO_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
    "MY_AGENT_TOKEN",
    "VENICE_API_KEY",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "ANTIGRAVITY_HARNESS_PATH",
    "AGY_ACP_DEFAULT_MODEL",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "LATERDOG_ANTHROPIC_API_KEY",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
const dumpState: Record<string, unknown> = { argv, env: dumpEnv, pid: process.pid };
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
}
if (process.env.FAKE_ACP_LAUNCH_COUNT_FILE) {
  let launches = 0;
  try {
    launches = Number.parseInt(readFileSync(process.env.FAKE_ACP_LAUNCH_COUNT_FILE, "utf8").trim(), 10) || 0;
  } catch {}
  try {
    writeFileSync(process.env.FAKE_ACP_LAUNCH_COUNT_FILE, String(launches + 1));
  } catch {}
}
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
if (argv[0] === "status" || argv[0] === "whoami") {
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  console.log(JSON.stringify({ isAuthenticated: authenticated }));
  process.exit(0);
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  const failOnce = process.env.FAKE_ACP_VERBOSE_FAIL_ONCE;
  if (failOnce && argv.includes("--verbose") && !existsSync(failOnce)) {
    writeFileSync(failOnce, "failed once\n");
    console.error("Failed to run the query 'CREATE TABLE `workspace` (…)'");
    process.exit(1);
  }
  if (process.env.FAKE_ACP_MODELS_LIST === "v2") {
    if (argv.includes("--verbose")) {
      console.error("Unrecognized flag: --verbose");
      process.exit(1);
    }
    process.exit(0);
  }
  if (models.length) {
    const verbose = argv.includes("--verbose");
    console.log(
      models.flatMap((slug) => verbose
        ? [
            slug,
            JSON.stringify({
              id: slug.slice(slug.indexOf("/") + 1),
              providerID: slug.slice(0, slug.indexOf("/")),
              name: slug,
              status: "active",
              limit: { context: 200_000 },
            }, null, 2),
          ]
        : [slug]).join("\n"),
    );
    process.exit(0);
  }
  console.log(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "gpt-5.3-codex - Codex 5.3",
      "cursor-live - Cursor Live",
    ].join("\n"),
  );
  process.exit(0);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
const configUpdates = JSON.parse(process.env.FAKE_ACP_CONFIG_UPDATES ?? "[]") as Array<{
  after: string; sessionId?: string; configOptions: unknown[]; replay?: boolean;
}>;
const emitConfigUpdates = (after: string, sessionId: string) => {
  for (const update of configUpdates.filter((entry) => entry.after === after)) {
    out({
      jsonrpc: "2.0", method: "session/update", params: {
        sessionId: update.sessionId ?? sessionId,
        ...(update.replay ? { _meta: { isReplay: true } } : {}),
        update: { sessionUpdate: "config_option_update", configOptions: update.configOptions },
      },
    });
  }
};
const resultAndConfigUpdates = (id: unknown, res: unknown, after: string, sessionId: string) => {
  const updates = configUpdates.filter((entry) => entry.after === after).map((update) => ({
    jsonrpc: "2.0", method: "session/update", params: {
      sessionId: update.sessionId ?? sessionId,
      ...(update.replay ? { _meta: { isReplay: true } } : {}),
      update: { sessionUpdate: "config_option_update", configOptions: update.configOptions },
    },
  }));
  process.stdout.write([{ jsonrpc: "2.0", id, result: res }, ...updates].map((message) => JSON.stringify(message)).join("\n") + "\n");
};
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
  if (process.env.FAKE_ACP_RPC_APPEND_FILE) {
    try {
      appendFileSync(process.env.FAKE_ACP_RPC_APPEND_FILE, JSON.stringify({ pid: process.pid, method, cwd: process.cwd() }) + "\n");
    } catch {}
  }
};

const configCalls: Array<{ method: string; params: unknown }> = [];

let pendingPermissionId: number | null = null;
let onPermissionAnswered: ((allowed: boolean) => void) | null = null;
let pendingAskQuestionId: number | null = null;
let onAskQuestionAnswered: (() => void) | null = null;

let hangingPromptId: unknown = null;
let hangKeepAlive: ReturnType<typeof setInterval> | null = null;

type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
let liveSession: string | null = null;
let rpcFailure: unknown = null;
function emitUsageUpdates(): void {
  const usageFile = process.env.FAKE_ACP_USAGE_UPDATES_FILE;
  if (usageFile && existsSync(usageFile)) {
    try {
      for (const used of JSON.parse(readFileSync(usageFile, "utf8")) as unknown[]) {
        if (typeof used === "number") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used, size: 200000 } } });
        }
      }
    } catch {}
  }
}
function failRpc(msg: { method: string; id: unknown }): boolean {
  if (msg.method !== (process.env.FAKE_ACP_RPC_FAILURE_METHOD ?? "session/prompt")) return false;
  const failureFile = process.env.FAKE_ACP_RPC_FAILURE_FILE;
  if (failureFile && existsSync(failureFile)) rpcFailure = JSON.parse(readFileSync(failureFile, "utf8"));
  if (!rpcFailure) return false;
  if (msg.method === "session/prompt" && process.env.FAKE_ACP_RPC_FAILURE_AFTER_USAGE === "1") emitUsageUpdates();
  if (msg.method === "session/prompt" && process.env.FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT === "1") playTurn();
  const fail = () => {
    recordMethod(`${msg.method}.error`);
    out({ jsonrpc: "2.0", id: msg.id, error: rpcFailure });
  };
  const gate = process.env.FAKE_ACP_RPC_FAILURE_GATE;
  if (gate && !existsSync(gate)) {
    const timer = setInterval(() => {
      if (!existsSync(gate)) return;
      clearInterval(timer);
      fail();
    }, 20);
  } else fail();
  return true;
}

function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>, strict = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1;
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (msg.error || (strict && msg.result?.isError)) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`Fixture MCP request failed: ${JSON.stringify(msg.error ?? msg.result)}`));
          return;
        }
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run", rawInput: { path: "/fixture/readme.md", password: "acp-input-secret" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: { text: "fixture file content", api_key: "acp-output-secret" } } } });
}

function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
}

function playReasoningTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "considering the request at length" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: " without ever producing an answer" } } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg: any) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingAskQuestionId) {
    pendingAskQuestionId = null;
    onAskQuestionAnswered?.();
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    const chosen = msg.result?.outcome?.optionId;
    if (process.env.FAKE_ACP_PERMISSION_ANSWER) writeFileSync(process.env.FAKE_ACP_PERMISSION_ANSWER, String(chosen ?? "cancelled"));
    onPermissionAnswered?.(typeof chosen === "string" && chosen.startsWith("allow"));
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);

  switch (msg.method) {
    case "initialize": {
      if (failRpc(msg)) break;
      if (mode === "hang-initialize") {
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: process.env.FAKE_ACP_AUTH_METHOD ?? "cached_token" }];
      const agentName = process.env.FAKE_ACP_AGENT_NAME;
      const acceptsImages = process.env.FAKE_ACP_IMAGE_CAPABILITY === "1";
      const mcpTransports = (process.env.FAKE_ACP_MCP_TRANSPORTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      result(msg.id, {
        protocolVersion: 1,
        authMethods,
        agentInfo: agentName
          ? { name: agentName, version: process.env.FAKE_ACP_AGENT_VERSION ?? "test" }
          : undefined,
        agentCapabilities: agentName || acceptsImages || mcpTransports.length
          ? {
              ...(agentName ? { loadSession: true, sessionCapabilities: { resume: true }, auth: { logout: true } } : {}),
              ...(acceptsImages ? { promptCapabilities: { image: true } } : {}),
              ...(mcpTransports.length ? { mcpCapabilities: { http: mcpTransports.includes("http"), sse: mcpTransports.includes("sse") } } : {}),
            }
          : undefined,
        _meta: {
          modelState: { currentModelId: "fake-acp-model" },
          ...(process.env.FAKE_ACP_GROK_VERSION ? { grokShell: true, agentVersion: process.env.FAKE_ACP_GROK_VERSION } : {}),
        },
      });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "_x.ai/mcp/list":
      result(msg.id, { result: { servers: [], sessionMcpResolved: true } });
      break;
    case "session/new": {
      if (failRpc(msg)) break;
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.session.json`, JSON.stringify(msg.params));
        dumpState.mcpServers = servers;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      liveSession = "fake-acp-session";
      resultAndConfigUpdates(msg.id, {
        sessionId: "fake-acp-session",
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      }, "session/new", "fake-acp-session");
      break;
    }
    case "session/load": {
      if (process.env.FAKE_ACP_LOAD_ERROR) {
        out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_ACP_LOAD_ERROR) });
        break;
      }
      if (process.env.FAKE_ACP_LOAD_NULL) {
        result(msg.id, null);
        break;
      }
      if (rejectLiveLoadFile && existsSync(rejectLiveLoadFile) && liveSession === msg.params?.sessionId) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "session already active in this agent" },
        });
        break;
      }
      const cachedLiveLoad = process.env.FAKE_ACP_CACHED_LIVE_LOAD === "1" && liveSession === msg.params?.sessionId;
      if (mode === "safe-agent-reads" && !cachedLiveLoad) {
        agentsMcp = (msg.params?.mcpServers ?? []).find((server: any) => server.name === "agents") ?? null;
      }
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(msg.params?.mcpServers ?? []));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      liveSession = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : liveSession;
      resultAndConfigUpdates(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) }, "session/load", msg.params.sessionId);
      break;
    }
    case "session/resume": {
      if (rejectLiveLoadFile && existsSync(rejectLiveLoadFile) && liveSession === msg.params?.sessionId) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "session already active in this agent" },
        });
        break;
      }
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(msg.params?.mcpServers ?? []));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      liveSession = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : liveSession;
      result(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) });
      break;
    }
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (mode === "set-model-invalid-params" && msg.method === "session/set_model") {
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (typeof msg.params?.sessionId !== "string" || typeof msg.params?.[settingId] !== "string") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      const variant = variantConfigs[currentModel ?? ""];
      if (variant && configId === (variant.id ?? "effort") && variantValues(variant.options).includes(value)) {
        if (!process.env.FAKE_ACP_VARIANT_STICKS) currentVariant = value;
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) {
          writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        }
        resultAndConfigUpdates(msg.id, process.env.FAKE_ACP_EMPTY_VARIANT_ACK ? {} : { configOptions: configOptions() }, "effort", msg.params.sessionId);
        break;
      }
      if (configId === "mode" && modes.includes(value)) {
        const ackFile = process.env.FAKE_ACP_MODE_ACK_FILE;
        const ack = ackFile && existsSync(ackFile) ? readFileSync(ackFile, "utf8").trim() : "";
        if (ack === "error") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error: could not change mode" } });
          break;
        }
        if (ack === "empty") {
          result(msg.id, {});
          break;
        }
        currentMode = value;
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) {
          writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        }
        result(msg.id, process.env.FAKE_ACP_EMPTY_MODE_ACK ? {} : { configOptions: configOptions() });
        break;
      }
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      if (!process.env.FAKE_ACP_MODEL_STICKS) {
        currentModel = value;
        currentVariant = variantConfigs[value]?.currentValue;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      resultAndConfigUpdates(msg.id, { configOptions: configOptions() }, "model", msg.params.sessionId);
      break;
    }
    case "session/prompt": {
      if (process.env.FAKE_ACP_DUMP && (modes.length || models.length)) {
        appendFileSync(`${process.env.FAKE_ACP_DUMP}.prompts.jsonl`, JSON.stringify({
          pid: process.pid, sessionId: msg.params?.sessionId, mode: currentMode, model: currentModel,
        }) + "\n");
      }
      emitConfigUpdates("session/prompt", msg.params.sessionId);
      if (process.env.FAKE_ACP_DUMP && process.env.FAKE_ACP_VARIANTS) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.selection.json`, JSON.stringify({
          sessionId: msg.params.sessionId, model: currentModel, variant: currentVariant,
        }));
      }
      if (process.env.FAKE_ACP_DUMP && process.env.FAKE_ACP_DUMP_PROMPT === "1") {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.prompt.json`, JSON.stringify(msg.params?.prompt ?? null, null, 2));
      }
      if (failRpc(msg)) return;
      if (mode === "hang") {
        hangingPromptId = msg.id;
        hangKeepAlive = setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "stall-after-text") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half an answer, then silence" } } } });
        hangingPromptId = msg.id;
        hangKeepAlive = setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "fail-after-text") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        emitUsageUpdates();
        recordMethod("session/prompt.result");
        result(
          msg.id,
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      if (mode === "quiet-then-answer") {
        const lines: string[] = process.env.FAKE_ACP_QWEN_LOG ? JSON.parse(process.env.FAKE_ACP_QWEN_LOG) : [];
        let logTimer: ReturnType<typeof setInterval> | null = null;
        if (lines.length && process.env.QWEN_HOME && liveSession) {
          const dir = `${process.env.QWEN_HOME}/debug`;
          mkdirSync(dir, { recursive: true });
          let i = 0;
          logTimer = setInterval(() => {
            appendFileSync(`${dir}/${liveSession}.txt`, `${new Date().toISOString()} ${lines[Math.min(i++, lines.length - 1)]}\n`);
          }, Number(process.env.FAKE_ACP_LOG_EVERY_MS ?? 100));
        }
        setTimeout(() => {
          if (logTimer) clearInterval(logTimer);
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
          complete();
        }, Number(process.env.FAKE_ACP_QUIET_MS ?? 600));
        return;
      }
      if (mode === "slow-tool" || mode === "stall-after-tool") {
        const tool = (update: Record<string, unknown>) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { toolCallId: "tc-slow", ...update } } });
        tool({ sessionUpdate: "tool_call", title: "sleep", rawInput: { command: "sleep 45 && echo done" } });
        tool({ sessionUpdate: "tool_call_update", status: "in_progress" });
        const finish = () => tool({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "done" } });
        if (mode === "stall-after-tool") {
          finish();
          hangingPromptId = msg.id;
          hangKeepAlive = setInterval(() => {}, 1_000);
          return;
        }
        setTimeout(() => {
          finish();
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
          complete();
        }, Number(process.env.FAKE_ACP_TOOL_MS ?? 600));
        return;
      }
      if (mode === "unkeyed-tool") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "run", rawInput: { command: "echo done" } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "done" } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
        complete();
        return;
      }
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      const wokeFromDelegation = promptText.includes("[A delegated task just completed]")
        || promptText.includes("[A delegated task failed]");
      if (wokeFromDelegation) {
        const failed = promptText.includes("[A delegated task failed]");
        const sawResult = promptText.includes("replied to the delegated task");
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: failed
                  ? "woke after delegation failure: will tell the user"
                  : sawResult
                    ? "woke after delegation: saw the result"
                    : "woke after delegation: no result",
              },
            },
          },
        });
        complete();
        return;
      }
      if (mode === "coordinate-peer" && agentsMcp && promptText.includes("COORDINATE_WITH_PEER")) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "coordinate_bots",
            args: (list) => ({ bot_ids: [/id: ([\w-]+)/.exec(list)?.[1] ?? ""], message: "guarded coordinated task" }),
          },
        ], true)
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `coordinated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `coordinate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "ask-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated") {
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        const started = process.env.FAKE_ACP_STARTED_FILE;
        if (started) writeFileSync(started, String(Date.now()));
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "delegated task",
              reason: "followup",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "image") {
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
            },
          },
        });
      } else if (mode === "interleave") playInterleaveTurn();
      else if (mode === "reasoning-only") playReasoningTurn();
      else if (mode !== "empty-reply") playTurn();
      if (mode === "safe-agent-reads" && agentsMcp) {
        const entry = agentsMcp;
        void (async () => {
          for (const name of ["list_bots", "session_search", "list_bots"]) {
            const nativeAuto = ["--permission-mode", "--approval-mode"].some((flag) => argv.includes(flag) && argv[argv.indexOf(flag) + 1] === "auto");
            if (!nativeAuto) {
              const allowed = await new Promise<boolean>((resolve) => {
                pendingPermissionId = 9100;
                onPermissionAnswered = resolve;
                out({ jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission", params: {
                  toolCall: { toolCallId: `fixture-${name}`, kind: "other", title: `agents__${name}`, rawInput: {} },
                  options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
                } });
              });
              if (!allowed) { complete(); return; }
            }
            const text = await driveMcp(entry, [{ name, args: () => name === "session_search" ? { query: "approval fixture" } : {} }], true);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: {
              sessionUpdate: "agent_message_chunk", content: { text: `${name}: ${text}\n` },
            } } });
          }
          complete();
        })().catch((error) => out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(error) } }));
        return;
      }
      if (mode === "permission") {
        pendingPermissionId = 9001;
        onPermissionAnswered = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "handled the permission decision" } } } });
          complete();
        };
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: process.env.FAKE_ACP_PERMISSION_TOOL_CALL
              ? JSON.parse(process.env.FAKE_ACP_PERMISSION_TOOL_CALL)
              : { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: process.env.FAKE_ACP_PERMISSION_OPTIONS ? JSON.parse(process.env.FAKE_ACP_PERMISSION_OPTIONS) : [
              { optionId: "allow-once", kind: "allow_once" },
              ...(process.env.FAKE_ACP_ALLOW_ALWAYS ? [{ optionId: "allow-always", kind: "allow_always" }] : []),
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      if (mode === "lend-question" && agentsMcp) {
        const entry = agentsMcp;
        const list = () => driveMcp(entry, [{ name: "list_shared_computers", args: () => ({}) }]).catch((e) => `error ${(e as Error).message}`);
        void (async () => {
          const before = await list();
          pendingPermissionId = 9003;
          onPermissionAnswered = () => {
            void list().then((after) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `before: ${before} | after: ${after}` } } } });
              complete();
            });
          };
          out({ jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission", params: {
            toolCall: { toolCallId: "interaction_folder", kind: "other", title: "Which folder should I read?" },
            options: [{ optionId: "docs-id", kind: "allow_once", name: "Docs" }, { optionId: "other-id", kind: "allow_once", name: "Other" }],
          } });
        })();
        return;
      }
      if (mode === "question") {
        pendingPermissionId = 9002;
        onPermissionAnswered = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "answered the question" } } } });
          complete();
        };
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: { toolCallId: "interaction_color", kind: "other", title: "Which color?" },
            options: process.env.FAKE_ACP_QUESTION_OPTIONS ? JSON.parse(process.env.FAKE_ACP_QUESTION_OPTIONS) : [
              { optionId: "blue-id", kind: "allow_once", name: "Blue" },
              {
                optionId: "green-id",
                kind: "allow_once",
                name: process.env.FAKE_ACP_PAD_QUESTION_OPTION ? " Green " : "Green",
              },
            ],
          },
        });
        return;
      }
      if (mode === "ask-question-unsupported") {
        pendingAskQuestionId = 9300;
        onAskQuestionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingAskQuestionId,
          method: "cursor/ask_question",
          params: { questions: [{ question: "Which color?", options: ["Blue", "Green"] }] },
        });
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      if (process.env.FAKE_ACP_IGNORE_CANCEL === "1") break;
      if (hangingPromptId !== null) {
        result(hangingPromptId, { stopReason: "cancelled", _meta: {} });
        if (hangKeepAlive) clearInterval(hangKeepAlive);
        hangingPromptId = null;
        hangKeepAlive = null;
      }
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
