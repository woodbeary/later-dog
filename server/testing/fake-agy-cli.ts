#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
}
if (argv.includes("--version")) {
  console.log(process.env.FAKE_AGY_VERSION ?? "1.1.22");
  process.exit(0);
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.FAKE_AGY_MCP_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const CONV = "conv-fake-123";

const streamInput = argv[argv.indexOf("--input-format") + 1] === "stream-json";
let prompt: string | undefined;
if (streamInput) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const line = input.split("\n").find((candidate) => candidate.trim());
  try {
    const message = line ? JSON.parse(line) : null;
    const content = message?.event === "user" ? message.message?.content : undefined;
    prompt = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text).join("")
        : undefined;
  } catch {}
} else {
  const printIdx = Math.max(argv.indexOf("--print"), argv.indexOf("-p"));
  prompt = printIdx !== -1 ? argv[printIdx + 1] : undefined;
}
if (!prompt) process.exit(0);
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env, prompt }, null, 2));
}

const toolName = "write_to_file";
out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "accept-edits" } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {} } } });

const response = "done from fake agy";

out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
out({ event: "result", conversation_id: CONV, result: { conversation_id: CONV, status: "SUCCESS", response, duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
