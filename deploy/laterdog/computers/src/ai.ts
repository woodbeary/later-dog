import type { Refusal } from "./auth";

export const AI_MAX_BODY_BYTES = 1024 * 1024;
export const AI_MAX_PROMPT_TOKENS = 100_000;
export const AI_TOKENS_PER_DAY = 1_500_000;
export const AI_TRIAL_TOKENS_PER_DAY = 300_000;
export const AI_TOKENS_TOTAL_PER_DAY = 100_000_000;
export const GROK_TOKENS_PER_DAY = 200_000;
export const GROK_TOKENS_TOTAL_PER_DAY = 20_000_000;
export const AI_DEFAULT_MODEL = "grok-4-1-fast-reasoning";
export const AI_WORKERS_MODEL = "@cf/moonshotai/kimi-k2.6";
export const AI_BUSY = "later.dog AI is busy right now. Try again in a minute.";
export const AI_BUSY_ERROR = { message: AI_BUSY, type: "server_error", code: "upstream_failed" };
export const AI_MAX_OUTPUT_TOKENS = 8_000;
const MAX_MESSAGES = 1_000;
const MAX_TOOLS = 256;
const PASSED = ["messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "response_format", "stop", "seed", "reasoning_effort"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const refuse = (message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status: 400, code: "invalid_request", message } });

export type ChatRequest = Record<string, unknown> & { model: string; stream: boolean };

const INLINE_IMAGE_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/;

const isInlineImageUrl = (url: unknown): boolean => typeof url === "string" && INLINE_IMAGE_URL.test(url);

const isAllowedPart = (part: unknown): boolean =>
  isRecord(part) && ((part.type === "text" && typeof part.text === "string") || (part.type === "image_url" && isRecord(part.image_url) && isInlineImageUrl(part.image_url.url)));

const hasAllowedContent = (message: Record<string, unknown>): boolean =>
  message.content === undefined || message.content === null || typeof message.content === "string" || (Array.isArray(message.content) && message.content.every(isAllowedPart));

export function chatRequest(body: unknown, model: string): { ok: true; request: ChatRequest } | { ok: false; refusal: Refusal } {
  if (!isRecord(body)) return refuse("Send a chat completion request.");
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES || !messages.every(isRecord)) {
    return refuse(`Send 1 to ${MAX_MESSAGES} messages.`);
  }
  if (!messages.every(hasAllowedContent)) return refuse("Message content can be text and inline PNG, JPEG, WebP or GIF images sent as base64 data URLs.");
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
  return Math.ceil(count(usage.prompt_tokens) + count(usage.completion_tokens));
}

export type TokenUsage = { total: number; output: number };

export function usageOf(usage: unknown): TokenUsage {
  const total = tokensOf(usage);
  return { total, output: isRecord(usage) ? Math.min(total, Math.ceil(count(usage.completion_tokens))) : 0 };
}

export async function streamedUsage(stream: ReadableStream<Uint8Array>): Promise<TokenUsage> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let usage: TokenUsage = { total: 0, output: 0 };
  const take = (line: string) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as { usage?: unknown };
      const counted = usageOf(chunk.usage);
      if (counted.total > 0) usage = counted;
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
  return usage;
}

export async function streamedTokens(stream: ReadableStream<Uint8Array>): Promise<number> {
  return (await streamedUsage(stream)).total;
}

export function workersInput(request: ChatRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { ...request, chat_template_kwargs: { thinking: false } };
  delete input.model;
  return input;
}


export function openAiStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = "";
  let head: Record<string, unknown> = {};
  let usage: unknown = null;
  let done = false;
  const summed = { prompt_tokens: 0, completion_tokens: 0 };
  const send = (controller: TransformStreamDefaultController<Uint8Array>, chunk: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (done) return;
    done = true;
    const total = usage ?? { ...summed, total_tokens: summed.prompt_tokens + summed.completion_tokens };
    send(controller, { ...head, object: "chat.completion.chunk", choices: [], usage: total });
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  const take = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return finish(controller);
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(chunk)) return;
    if (!Array.isArray(chunk.choices)) {
      if (isRecord(chunk.usage)) usage = chunk.usage;
      else send(controller, chunk.error !== undefined ? { error: AI_BUSY_ERROR } : chunk);
      return;
    }
    if (isRecord(chunk.usage)) {
      summed.prompt_tokens += count(chunk.usage.prompt_tokens);
      summed.completion_tokens += count(chunk.usage.completion_tokens);
    }
    head = { id: chunk.id, created: chunk.created, model: chunk.model };
    if (chunk.choices.length === 0) return;
    const rest: Record<string, unknown> = { ...chunk };
    delete rest.usage;
    delete rest.p;
    send(controller, rest);
  };
  return stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
    transform(text, controller) {
      buffer += text;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        take(buffer.slice(0, end).trim(), controller);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      take(buffer.trim(), controller);
      finish(controller);
    },
  }));
}

export function plainErrors(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = "";
  const line = (text: string) => {
    const data = text.trim().startsWith("data:") ? text.trim().slice(5).trim() : "";
    if (!data.startsWith("{")) return text;
    try {
      const chunk: unknown = JSON.parse(data);
      return isRecord(chunk) && chunk.error !== undefined ? `data: ${JSON.stringify({ error: AI_BUSY_ERROR })}` : text;
    } catch {
      return text;
    }
  };
  return stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
    transform(text, controller) {
      buffer += text;
      const end = buffer.lastIndexOf("\n");
      if (end < 0) return;
      controller.enqueue(encoder.encode(buffer.slice(0, end + 1).split("\n").map(line).join("\n")));
      buffer = buffer.slice(end + 1);
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(line(buffer)));
    },
  }));
}

type Frame = "pending" | "ok" | "error";

function firstFrame(text: string): Frame {
  const lines = text.split("\n");
  lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") return "error";
    try {
      const chunk: unknown = JSON.parse(data);
      return isRecord(chunk) && chunk.error !== undefined ? "error" : "ok";
    } catch {
      return "ok";
    }
  }
  return "pending";
}

export async function usableStream(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array> | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const seen: Uint8Array[] = [];
  let text = "";
  let frame: Frame = "pending";
  let ended = false;
  while (frame === "pending" && text.length < 65_536) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    seen.push(value);
    text += decoder.decode(value, { stream: true });
    frame = firstFrame(text);
  }
  if (frame === "error" || (frame === "pending" && ended)) {
    await reader.cancel().catch(() => {});
    return null;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of seen) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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
