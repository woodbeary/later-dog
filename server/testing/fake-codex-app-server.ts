#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";


const mode = process.env.FAKE_CODEX_MODE ?? "happy";

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

const waitForGate = (path: string | undefined, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if ((path !== undefined && existsSync(path)) || Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 2);
  });

if (process.argv[2] === "--version") {
  process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.147.0"}\n`);
  process.exit(0);
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  const statusStream = mode === "logged-in-stdout" ? process.stdout : process.stderr;
  statusStream.write("Logged in using ChatGPT\n");
  process.exit(0);
}
const calls: Array<{ method: string; params: unknown }> = [];
const mcpOverrides: Record<string, Record<string, unknown>> = {};
for (let index = 0; process.env.FAKE_CODEX_MCP_OVERRIDES === "1" && index < process.argv.length; index++) {
  const match = process.argv[index - 1] === "-c" ? /^mcp_servers\.([^.]+)\.([^.]+)=(.*)$/.exec(process.argv[index]!) : null;
  if (match) (mcpOverrides[match[1]!] ??= {})[match[2]!] = JSON.parse(match[3]!);
}
const shellExcludeOverride = process.argv.reduce<unknown>((found, arg, index) => {
  const match = process.argv[index - 1] === "-c" ? /^shell_environment_policy\.exclude=(.*)$/.exec(arg) : null;
  return match ? JSON.parse(match[1]!) : found;
}, undefined);
const shellEnvironmentPolicy = (): unknown => {
  const unset = { inherit: null, ignore_default_excludes: null, exclude: null, set: null,
    include_only: null, filters: null, experimental_use_profile: null };
  const supplied: unknown = process.env.FAKE_CODEX_SHELL_ENVIRONMENT_POLICY ? JSON.parse(process.env.FAKE_CODEX_SHELL_ENVIRONMENT_POLICY) : {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return supplied;
  return { ...unset, ...supplied, ...(shellExcludeOverride !== undefined ? { exclude: shellExcludeOverride, filters: null } : {}) };
};
let developerInstructions = "";
let resumedThread: string | null = null;
let decision: unknown = null;
let experimentalApi = false;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
let nativeThreadId = "codex-thread-1";
const nativeTurnId = "turn-1";
const notify = (method: string, params: any) => out({
  jsonrpc: "2.0", method,
  params: {
    threadId: nativeThreadId,
    ...(method.startsWith("turn/") ? {} : { turnId: nativeTurnId }),
    ...params,
    ...(params.turn ? { turn: { id: nativeTurnId, ...params.turn } } : {}),
  },
});

const resolvedSandbox = (params: Record<string, unknown>) => {
  if (process.env.FAKE_CODEX_RESOLVED_SANDBOX) return JSON.parse(process.env.FAKE_CODEX_RESOLVED_SANDBOX);
  if (params.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (params.sandbox === "workspace-write") return {
    type: "workspaceWrite", networkAccess: false, writableRoots: [],
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  };
  return { type: "readOnly" };
};

const threadReply = (response: unknown) => {
  if (!process.env.FAKE_CODEX_RESTORED_USAGE) return out(response);
  const restored = {
    jsonrpc: "2.0", method: "thread/tokenUsage/updated",
    params: { threadId: nativeThreadId, turnId: nativeTurnId,
      tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } } },
  };
  process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(restored)}\n`);
};

const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const writeDumpAtomic = (path: string, contents: string): void => {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        try { unlinkSync(tmp); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
};
const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeDumpAtomic(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: process.env, calls, decision }, null, 2),
    );
  }
};

const finishTurn = () => {
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed", aggregatedOutput: "README.md\nAPI_KEY=codex-output-secret", exitCode: 0 } });
  notify("item/completed", { item: { id: "w1", type: "webSearch", status: "completed" } });
  if (mode === "stream") {
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  if (mode === "image") {
    notify("item/completed", {
      item: {
        id: "img1",
        type: "imageGeneration",
        status: "completed",
        result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        revisedPrompt: "a tiny green mouse",
        savedPath: "/tmp/provider-owned-path-must-not-be-read.png",
      },
    });
  }
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: process.env.FAKE_CODEX_REPLY || "done from fake codex" } });
  const carried = process.env.FAKE_CODEX_RESTORED_USAGE ? { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  notify("thread/tokenUsage/updated", { tokenUsage: {
    total: { inputTokens: carried.inputTokens + 7, cachedInputTokens: carried.cachedInputTokens + 4, outputTokens: carried.outputTokens + 3 },
    last: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 },
    modelContextWindow: 272000,
  } });
  dump();
  if (mode === "late-request") process.stdout.cork();
  notify("turn/completed", { turn: { status: "completed" } });
  if (mode === "late-request") {
    out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "echo too late" } });
    process.stdout.uncork();
  }
};

const playRoomPlanTurn = (msg: any, planPath: string) => {
  const ack = () => out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
  const early = process.env.FAKE_CODEX_COMPLETE_BEFORE_ACK === "1";
  const setting = (key: string) => {
    const entry = process.argv.find((arg) => arg.startsWith(`mcp_servers.agents.${key}=`));
    return entry ? JSON.parse(entry.slice(entry.indexOf("=") + 1)) : undefined;
  };
  const integration = {
    command: setting("command"),
    args: setting("args") ?? [],
    env: Object.fromEntries((setting("env_vars") ?? []).map((key: string) => [key, process.env[key] ?? ""])),
  };
  const text = (msg.params?.input ?? []).filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
  if (!early) ack();
  void import("./room-handoff-agent.ts").then(({ runRoomHandoffAgent }) => runRoomHandoffAgent(process.argv.slice(2), planPath, { message: { content: text } },
    { integration, system: developerInstructions, evidence: { resumedThread } }))
    .then((reply) => {
      notify("item/completed", { item: { id: "m1", type: "agentMessage", text: reply } });
      notify("turn/completed", { turn: { status: "completed" } });
    })
    .catch((error) => notify("turn/completed", { turn: { status: "failed", error: { message: String(error) } } }))
    .finally(() => { if (early) ack(); });
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
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

    if ((msg.id === 100 || msg.id === 101) && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      if ((mode === "question" || mode === "multi-question" || mode === "empty-question") && process.env.FAKE_CODEX_ASK_HOLD === "1") {
        dump();
      } else {
        finishTurn();
      }
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });

    switch (msg.method) {
      case "initialize":
        experimentalApi = msg.params?.capabilities?.experimentalApi === true;
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "account/read": {
        dump();
        const accountMode = process.env.FAKE_CODEX_ACCOUNT_MODE;
        if (accountMode === "hang") break;
        if (accountMode === "unsupported" || accountMode === "error") {
          out({ jsonrpc: "2.0", id: msg.id, error: {
            code: accountMode === "unsupported" ? -32601 : -32000,
            message: "Offline fixture account read unavailable",
          } });
          break;
        }
        const account = accountMode === "none" || mode === "logged-out" ? null
          : accountMode === "api-key" ? { type: "apiKey" }
          : { type: "chatgpt", email: process.env.FAKE_CODEX_ACCOUNT_EMAIL ?? "ada@example.test", planType: "pro" };
        out({ jsonrpc: "2.0", id: msg.id, result: { account, requiresOpenaiAuth: true } });
        break;
      }
      case "model/list":
        if (msg.params?.cursor === "page-2") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
                { id: "gpt-page-two", displayName: "GPT Page Two", hidden: false, isDefault: false },
              ],
              nextCursor: null,
            },
          });
        } else {
          const hasAstra = process.env.FAKE_CODEX_ASTRA === "1";
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                ...(hasAstra
                  ? [{ id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, isDefault: true,
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
                    defaultReasoningEffort: "medium" }]
                  : []),
                { id: "gpt-fake-default", displayName: "GPT Fake Default", hidden: false, isDefault: !hasAstra },
              ],
              nextCursor: "page-2",
            },
          });
        }
        break;
      case "config/read":
        if (mode === "config-read-error") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "config unavailable" } });
          break;
        }
        out({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            config: {
              ...(mode === "config-profile" || mode === "config-profile-unsupported"
              ? {
                  default_permissions: "private-operator-profile",
                  permissions: {
                    "private-operator-profile": { extends: ":danger-full-access" },
                  },
                  approval_policy: null,
                  approvals_reviewer: null,
                  sandbox_mode: "read-only",
                }
              : {
                  approval_policy: "never",
                  approvals_reviewer: "auto_review",
                  sandbox_mode: "read-only",
                  mcp_servers: process.env.FAKE_CODEX_MCP_OVERRIDES === "1" ? mcpOverrides : process.env.FAKE_CODEX_MCP_CONFIG ? JSON.parse(process.env.FAKE_CODEX_MCP_CONFIG) : {
                    harmless_name: { env: { DISPLAY_LABEL: "innocuous-config-secret-7a9c" } },
                  },
                }),
              developer_instructions: process.env.FAKE_CODEX_INSTRUCTIONS ?? null,
              shell_environment_policy: shellEnvironmentPolicy(),
              features: Object.fromEntries(process.argv.flatMap((arg, index) => {
                const match = process.argv[index - 1] === "-c" ? /^features\.(\w+)=(true|false)$/.exec(arg) : null;
                return match && process.env.FAKE_CODEX_IGNORE_FEATURES !== "1" ? [[match[1], match[2] === "true"]] : [];
              })),
            },
            origins: {},
          },
        });
        break;
      case "thread/resume":
        dump();
        developerInstructions = msg.params?.developerInstructions ?? "";
        resumedThread = msg.params?.threadId ?? null;
        if (process.env.FAKE_CODEX_RESUME_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_RESUME_ERROR) });
        } else if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else if (mode === "resume" || mode === "usage-limit" || mode === "review-events" || mode === "helper-events" || mode === "instructions-unsupported" || mode === "config-profile" || mode === "config-profile-unsupported" ||
            (mode === "resume-then-missing" && !existsSync(process.env.FAKE_CODEX_STATE ?? ""))) {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId }, sandbox: resolvedSandbox(msg.params ?? {}) } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${msg.params?.threadId}` } });
        }
        break;
      case "thread/inject_items":
        if (mode === "instructions-unsupported") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      case "turn/steer": {
        dump();
        const refused = (message: string) =>
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
        if (process.env.FAKE_CODEX_STEER_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_STEER_ERROR) });
          break;
        }
        if (process.env.FAKE_CODEX_STEER_ERROR_FILE && existsSync(process.env.FAKE_CODEX_STEER_ERROR_FILE)) {
          refused("active turn is not steerable");
          break;
        }
        if (process.env.FAKE_CODEX_STEER_HANG) break;
        if (msg.params?.expectedTurnId !== nativeTurnId) {
          refused("active turn is not steerable");
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { turnId: nativeTurnId } });
        break;
      }
      case "turn/interrupt":
        dump();
        if (process.env.FAKE_CODEX_INTERRUPT_SILENT) break;
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        notify("turn/completed", { turn: { status: "interrupted" } });
        break;
      case "thread/start":
        dump();
        developerInstructions = msg.params?.developerInstructions ?? "";
        if (process.env.FAKE_CODEX_START_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_START_ERROR) });
        } else if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model", sandbox: resolvedSandbox(msg.params ?? {}) } });
        }
        break;
      case "turn/start": {
        dump();
        nativeThreadId = msg.params?.threadId ?? nativeThreadId;
        if (process.env.FAKE_CODEX_LAUNCH_CRASHES && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const crashes = Number(process.env.FAKE_CODEX_LAUNCH_CRASHES) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < crashes) {
            console.error("Error: connection reset by peer");
            process.exit(1);
          }
        }
        if (process.env.FAKE_CODEX_LAUNCH_KILLS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const kills = Number(process.env.FAKE_CODEX_LAUNCH_KILLS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < kills) {
            console.error("Error: connection reset by peer");
            setTimeout(() => process.kill(process.pid, "SIGKILL"), 15);
            break;
          }
        }
        if (process.env.FAKE_CODEX_LAUNCH_SILENT && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const silent = Number(process.env.FAKE_CODEX_LAUNCH_SILENT) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < silent) {
            process.exit(1);
          }
        }
        if (mode === "safety-rpc") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "HTTP 503: This task was blocked by our safety systems." } });
          break;
        }
        if (mode === "safety-completion" || mode === "safety-notification") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const message = "This task was blocked by our safety systems.";
          if (mode === "safety-notification") notify("error", { message });
          notify("turn/completed", { turn: { status: "failed", error: { message } } });
          break;
        }
        if (process.env.FAKE_CODEX_PROMPTS) {
          const text = (msg.params?.input ?? []).filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
          appendFileSync(process.env.FAKE_CODEX_PROMPTS, JSON.stringify({ text }) + "\n");
        }
        if (mode === "usage-limit" && (!process.env.FAKE_CODEX_USAGE_LIMIT_GATE || existsSync(process.env.FAKE_CODEX_USAGE_LIMIT_GATE))) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const resetsAt = Math.floor(Date.now() / 1000) + (Number(process.env.FAKE_CODEX_USAGE_RESETS_IN) || 3600);
          notify("account/rateLimits/updated", { rateLimits: {
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetsAt + 6 * 86_400 },
          } });
          const error = {
            message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.",
            codexErrorInfo: "usageLimitExceeded", additionalDetails: null,
          };
          notify("error", { error, willRetry: false });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
          break;
        }
        if (mode === "retry-then-complete" || mode === "signin-refused") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          for (let attempt = 1; attempt <= 5; attempt++) {
            notify("error", { willRetry: true, error: { message: `Reconnecting... ${attempt}/5`, codexErrorInfo: null, additionalDetails: "workspace routing discovery unauthorized (401)" } });
          }
          if (mode === "retry-then-complete") { finishTurn(); break; }
          const error = { message: "workspace routing discovery unauthorized (401)", codexErrorInfo: "unauthorized", additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        if (mode === "auth-recovery") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("modelProvider/authRecoveryStarted", { provider: "openai", message: "Refreshing sign-in" });
          notify("turn/completed", { turn: { status: "failed", error: { message: "unexpected status 401 Unauthorized", codexErrorInfo: null } } });
          break;
        }
        if (mode === "key-401") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const error = { message: "unexpected status 401 Unauthorized: Incorrect API key provided", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        const recovery = /^(recovered|recovering)-(401|403)$/.exec(mode);
        if (recovery) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("modelProvider/authRecoveryStarted", { provider: "openai", message: "Refreshing sign-in" });
          if (recovery[1] === "recovered") notify("modelProvider/authRecoveryCompleted", { provider: "openai", message: "Signed in" });
          const message = recovery[2] === "403" ? "unexpected status 403 Forbidden: unauthorized client" : "unexpected status 401 Unauthorized";
          notify("turn/completed", { turn: { status: "failed", error: { message, codexErrorInfo: recovery[2] === "403" ? { responseStreamConnectionFailed: { httpStatusCode: 403 } } : null } } });
          break;
        }
        if (mode === "mcp-401") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("item/completed", { item: { id: "t1", type: "mcpToolCall", tool: "fetch", status: "failed", error: { message: "HTTP 401 Unauthorized: Please sign in again" } } });
          finishTurn();
          break;
        }
        if (mode === "legacy-error") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("error", { message: "stream disconnected before completion" });
          notify("turn/completed", { turn: { status: "failed", error: { message: "stream disconnected before completion" } } });
          break;
        }
        if (mode === "unauthorized") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            },
          });
          break;
        }
        if (process.env.FAKE_CODEX_TRANSIENTS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const quota = Number(process.env.FAKE_CODEX_TRANSIENTS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < quota) {
            if (process.env.FAKE_CODEX_PARTIAL_FAILS) {
              out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
              notify("item/agentMessage/delta", { itemId: "m1", delta: "half an answer" });
              notify("turn/completed", { turn: { status: "failed", error: { message: "provider overloaded, try again" } } });
              break;
            }
            out({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" },
            });
            break;
          }
        }
        if (process.env.FAKE_CODEX_ACK_CRASH) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          void waitForGate(process.env.FAKE_CODEX_ACK_CRASH).then(() => {
            console.error("Error: connection reset by peer");
            process.exit(1);
          });
          break;
        }
        if (process.env.FAKE_CODEX_EXIT_MID_TURN) {
          console.error("2026-09-14T20:24:19Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 426 Upgrade Required, url: ws://127.0.0.1:10100/v1/responses");
          void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN).then(() => {
            out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
            notify("item/reasoning/textDelta", { itemId: "m1", delta: "still thinking" });
            void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN_KILL).then(() =>
              process.kill(process.pid, "SIGKILL"),
            );
          });
          break;
        }
        if (process.env.FAKE_CODEX_ROOM_PLAN) {
          playRoomPlanTurn(msg, process.env.FAKE_CODEX_ROOM_PLAN);
          break;
        }
        if (mode === "early-turn-events") finishTurn();
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
        if (mode === "early-turn-events") break;
        if (mode === "helper-events") {
          notify("item/completed", { item: { id: "spawn-helper", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["helper-thread"], agentsStates: { "helper-thread": { status: "running", message: null } } } });
          notify("item/started", { item: { id: "helper-active", type: "subAgentActivity", kind: "started", agentThreadId: "helper-thread", agentPath: "/root/checker" } });
          notify("item/completed", { item: { id: "wait-helper", type: "collabAgentToolCall", tool: "wait", status: "completed", receiverThreadIds: ["helper-thread"], agentsStates: { "helper-thread": { status: "completed", message: "Checked the outline" } } } });
          for (const scope of [
            { threadId: "helper-thread", turnId: "helper-turn" },
            { threadId: nativeThreadId, turnId: "previous-turn" },
            { threadId: null, turnId: null },
          ]) {
            notify("item/agentMessage/delta", { ...scope, delta: "FOREIGN answer" });
            notify("item/reasoning/textDelta", { ...scope, delta: "FOREIGN reasoning" });
            notify("item/started", { ...scope, item: { id: "foreign-tool", type: "commandExecution", command: "FOREIGN command" } });
            notify("item/completed", { ...scope, item: { type: "agentMessage", text: "FOREIGN final" } });
            notify("thread/tokenUsage/updated", { ...scope, tokenUsage: { total: { inputTokens: 999, outputTokens: 999 } } });
            notify("error", { ...scope, message: "FOREIGN error" });
            notify("turn/completed", { ...scope, turn: { id: scope.turnId, status: "completed" } });
            notify("turn/completed", { ...scope, turn: { id: scope.turnId, status: "failed" } });
          }
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "echo parent continues" } });
          break;
        }
        const command = mode === "windows-command"
          ? [
              "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
              "-Command",
              `"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'"`,
            ].join(" ")
          : "ls -la";
        notify("item/started", { item: { id: "i1", type: "commandExecution", command } });
        notify("item/started", { item: { id: "w1", type: "webSearch", query: "later.dog" } });
        const reviewOnce = process.env.FAKE_CODEX_REVIEW_ONCE_FILE;
        if (process.env.FAKE_CODEX_REVIEW_EVENTS && (!reviewOnce || !existsSync(reviewOnce))) {
          if (reviewOnce) writeFileSync(reviewOnce, "1");
          for (const event of JSON.parse(process.env.FAKE_CODEX_REVIEW_EVENTS)) {
            out({ jsonrpc: "2.0", method: event.method, params: event.params });
          }
        }
        if (mode === "mcp-elicitation") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
              message: 'Allow the agents MCP server to run tool "list_bots"?',
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "mcp-app-approval") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "computer-use",
              mode: "form",
              message: "Allow ChatGPT to use Safari?",
              _meta: { app_name: "Safari", persist: ["session", "always"] },
              requestedSchema: {
                type: "object",
                properties: {
                  approval: {
                    type: "string",
                    oneOf: [
                      { const: "once", title: "Allow once" },
                      { const: "session", title: "Allow for this session" },
                      { const: "always", title: "Always allow Safari" },
                    ],
                  },
                },
                required: ["approval"],
              },
            },
          });
        } else if (mode === "mcp-form") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "example",
              mode: "form",
              message: "Enter an API key",
              requestedSchema: {
                type: "object",
                properties: { apiKey: { type: "string" } },
                required: ["apiKey"],
              },
            },
          });
        } else if (mode === "permissions-approval") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "item/permissions/requestApproval",
            params: {
              threadId: "codex-thread-1",
              turnId: "turn-1",
              itemId: "permission-1",
              cwd: "/tmp",
              startedAtMs: Date.now(),
              reason: "Needs network access",
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
            },
          });
        } else if (
          mode === "question" ||
          mode === "multi-question" ||
          mode === "mixed-question" ||
          mode === "empty-question" ||
          mode === "malformed-question"
        ) {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "item/tool/requestUserInput",
            params: {
              questions: mode === "malformed-question"
                ? "please"
                : mode === "question"
                ? [{
                    id: "q-ship",
                    question: "Ship today?",
                    options: ["Yes", "No", "Maybe", "Later", "Soon", "Never"].map((label) => ({ label })),
                  }]
                : mode === "mixed-question"
                ? [
                    { id: "q-broken", question: "   ", options: [{ label: "Broken choice" }] },
                    { id: "q-review", question: "Who reviews?", options: [{ label: "Ada" }, { label: "Lin" }] },
                  ]
                : mode === "empty-question"
                ? []
                : [
                    { id: "q-ship", question: "Ship today?", options: [{ label: "Yes" }, { label: "No" }] },
                    { id: "q-review", question: "Who reviews?", options: [{ label: "Ada" }, { label: "Lin" }] },
                  ],
            },
          });
        } else if (mode === "approval" || mode === "windows-command") {
          const approvalCommand = mode === "windows-command" ? command : "rm -rf scratch";
          const approval = process.env.FAKE_CODEX_APPROVAL_REQUEST
            ? JSON.parse(process.env.FAKE_CODEX_APPROVAL_REQUEST)
            : { method: "execCommandApproval", params: { command: approvalCommand } };
          out({ jsonrpc: "2.0", id: 100, ...approval });
        } else {
          finishTurn();
          if (process.env.FAKE_CODEX_REVIEW_AFTER_COMPLETION) {
            const event = JSON.parse(process.env.FAKE_CODEX_REVIEW_AFTER_COMPLETION);
            out({ jsonrpc: "2.0", method: event.method, params: event.params });
          }
        }
        break;
      }
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

setInterval(() => {}, 1_000);
