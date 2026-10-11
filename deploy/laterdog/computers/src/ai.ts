import type { Refusal } from "./auth";

export const AI_MAX_BODY_BYTES = 6 * 1024 * 1024;
export const AI_TOKENS_PER_DAY = 1_500_000;
export const AI_TOKENS_TOTAL_PER_DAY = 100_000_000;
export const AI_DEFAULT_MODEL = "grok-4-1-fast-reasoning";
export const AI_MAX_OUTPUT_TOKENS = 32_000;
const MAX_MESSAGES = 1_000;
const MAX_TOOLS = 256;
const PASSED = ["messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "response_format", "stop", "seed", "reasoning_effort"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const refuse = (message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status: 400, code: "invalid_request", message } });

export type ChatRequest = Record<string, unknown> & { model: string; stream: boolean };

export function chatRequest(body: unknown, model: string): { ok: true; request: ChatRequest } | { ok: false; refusal: Refusal } {
  if (!isRecord(body)) return refuse("Send a chat completion request.");
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES || !messages.every(isRecord)) {
    return refuse(`Send 1 to ${MAX_MESSAGES} messages.`);
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS)) return refuse(`Send at most ${MAX_TOOLS} tools.`);
  const stream = body.stream === true;
  const request: ChatRequest = { model, stream };
  for (const field of PASSED) if (body[field] !== undefined) request[field] = body[field];
  const asked = typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : AI_MAX_OUTPUT_TOKENS;
  request.max_tokens = Math.max(1, Math.min(AI_MAX_OUTPUT_TOKENS, Math.floor(asked)));
  if (stream) request.stream_options = { include_usage: true };
  return { ok: true, request };
}

export function tokensOf(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const total = usage.total_tokens;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return Math.ceil(total);
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return Math.ceil(count(usage.prompt_tokens) + count(usage.completion_tokens));
}

export async function streamedTokens(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let tokens = 0;
  const take = (line: string) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as { usage?: unknown };
      const counted = tokensOf(chunk.usage);
      if (counted > 0) tokens = counted;
    } catch {
      return;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      take(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  }
  take(buffer.trim());
  return tokens;
}

export function grokRequest(request: ChatRequest, key: string) {
  return {
    provider: "grok",
    endpoint: "v1/chat/completions",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "cf-aig-collect-log": false,
      "cf-aig-request-timeout": 120_000,
    },
    query: request,
  };
}
