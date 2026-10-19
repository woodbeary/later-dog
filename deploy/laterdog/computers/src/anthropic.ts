import { AI_BUSY_ERROR, AI_MAX_OUTPUT_TOKENS, type ChatRequest } from "./ai";
import type { TokenBudget } from "./usage-reserve";

export const AI_ANTHROPIC_MODEL = "claude-haiku-5-5";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_TOKENS_TOTAL_PER_DAY = 40_000_000;
export const ANTHROPIC_STREAM_FIRST_BYTE_MS = 20_000;
export const ANTHROPIC_ANSWER_MS = 120_000;
const EFFORTS = new Map<string, "low" | "medium" | "high">([["none", "low"], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"]]);
const TOOL_ID = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/;

type Block = Record<string, unknown>;
type Turn = { role: "user" | "assistant"; content: Block[] };
export type MessagesRequest = Record<string, unknown> & { model: string; max_tokens: number; stream: boolean; messages: Turn[] };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export function anthropicFirst(env: Env): boolean {
  return env.ANTHROPIC_FIRST?.trim() === "1";
}

export function anthropicModel(env: Env): string {
  return env.TRIAL_AI_ANTHROPIC_MODEL?.trim() || AI_ANTHROPIC_MODEL;
}

export function anthropicBudget(env: Env): TokenBudget {
  const set = env.ANTHROPIC_TOKENS_PER_DAY?.trim() ?? "";
  const total = /^\d+$/.test(set) ? Number.parseInt(set, 10) : ANTHROPIC_TOKENS_TOTAL_PER_DAY;
  return { kind: "anthropic_tokens", perKey: total, perFullKey: total, total };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36);
}

export function claudeToolId(id: string): string {
  return TOOL_ID.test(id) ? id : `${id.replace(/[^A-Za-z0-9_-]/g, "_")}_${fnv1a(id)}`;
}

function partBlock(part: unknown): Block | null | "skip" {
  if (!isRecord(part)) return null;
  if (part.type === "text" && typeof part.text === "string") return part.text ? { type: "text", text: part.text } : "skip";
  if (part.type !== "image_url" || !isRecord(part.image_url) || typeof part.image_url.url !== "string") return null;
  const inline = DATA_URL.exec(part.image_url.url);
  return inline ? { type: "image", source: { type: "base64", media_type: inline[1], data: inline[2] } } : null;
}

function contentBlocks(content: unknown): Block[] | null {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return null;
  const blocks: Block[] = [];
  for (const part of content) {
    const block = partBlock(part);
    if (block === null) return null;
    if (block !== "skip") blocks.push(block);
  }
  return blocks;
}

function systemText(content: unknown): string | null {
  const blocks = contentBlocks(content);
  if (!blocks || blocks.some((block) => block.type !== "text")) return null;
  return blocks.map((block) => block.text as string).join("\n");
}

function toolUse(call: unknown): Block | null {
  if (!isRecord(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || !isRecord(call.function) || typeof call.function.name !== "string" || !TOOL_NAME.test(call.function.name)) return null;
  const raw = call.function.arguments;
  let input: unknown = raw;
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) input = {};
  else if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return isRecord(input) ? { type: "tool_use", id: claudeToolId(call.id), name: call.function.name, input } : null;
}

function messageBlocks(message: Record<string, unknown>): { role: Turn["role"]; blocks: Block[] } | null {
  if (message.role === "user") {
    const blocks = contentBlocks(message.content);
    return blocks ? { role: "user", blocks } : null;
  }
  if (message.role === "assistant") {
    const blocks = contentBlocks(message.content);
    if (!blocks || blocks.some((block) => block.type !== "text")) return null;
    const calls = message.tool_calls === undefined || message.tool_calls === null ? [] : message.tool_calls;
    if (!Array.isArray(calls)) return null;
    for (const call of calls) {
      const block = toolUse(call);
      if (!block) return null;
      blocks.push(block);
    }
    return { role: "assistant", blocks };
  }
  if (message.role === "tool") {
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id) return null;
    const content = contentBlocks(message.content);
    if (!content) return null;
    return { role: "user", blocks: [{ type: "tool_result", tool_use_id: claudeToolId(message.tool_call_id), ...(content.length ? { content } : {}) }] };
  }
  return null;
}

function turns(messages: unknown): { system: string[]; turns: Turn[] } | null {
  if (!Array.isArray(messages)) return null;
  const system: string[] = [];
  const out: Turn[] = [];
  for (const message of messages) {
    if (!isRecord(message)) return null;
    if (message.role === "system" || message.role === "developer") {
      if (out.length) return null;
      const text = systemText(message.content);
      if (text === null) return null;
      if (text) system.push(text);
      continue;
    }
    const translated = messageBlocks(message);
    if (!translated) return null;
    if (!translated.blocks.length) continue;
    const last = out.at(-1);
    if (last?.role === translated.role) last.content.push(...translated.blocks);
    else out.push({ role: translated.role, content: translated.blocks });
  }
  if (out[0]?.role !== "user" || out.at(-1)?.role !== "user") return null;
  return { system, turns: out };
}

function tools(value: unknown): Block[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: Block[] = [];
  for (const tool of value) {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function) || typeof tool.function.name !== "string" || !TOOL_NAME.test(tool.function.name)) return null;
    const parameters = tool.function.parameters;
    if (parameters !== undefined && !isRecord(parameters)) return null;
    out.push({
      name: tool.function.name,
      ...(typeof tool.function.description === "string" && tool.function.description ? { description: tool.function.description } : {}),
      input_schema: parameters ? { type: "object", ...parameters } : { type: "object", properties: {} },
    });
  }
  return out;
}

function toolChoice(value: unknown, parallel: unknown): Block | null {
  const single = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (value === undefined || value === "auto") return { type: "auto", ...single };
  if (value === "none") return { type: "none" };
  if (value === "required") return { type: "any", ...single };
  if (isRecord(value) && value.type === "function" && isRecord(value.function) && typeof value.function.name === "string") return { type: "tool", name: value.function.name, ...single };
  return null;
}

function stopSequences(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

function outputFormat(value: unknown): Block | null | undefined {
  if (value === undefined || value === null || (isRecord(value) && value.type === "text")) return undefined;
  if (isRecord(value) && value.type === "json_schema" && isRecord(value.json_schema) && isRecord(value.json_schema.schema)) return { type: "json_schema", schema: value.json_schema.schema };
  return null;
}

export function messagesRequest(request: ChatRequest, model: string): MessagesRequest | null {
  const conversation = turns(request.messages);
  const toolList = tools(request.tools);
  const stop = stopSequences(request.stop);
  const format = outputFormat(request.response_format);
  if (!conversation || !toolList || !stop || format === null) return null;
  const effort = typeof request.reasoning_effort === "string" ? EFFORTS.get(request.reasoning_effort) : undefined;
  const body: MessagesRequest = {
    model,
    max_tokens: typeof request.max_tokens === "number" ? request.max_tokens : AI_MAX_OUTPUT_TOKENS,
    stream: request.stream,
    messages: conversation.turns,
    thinking: { type: "disabled" },
    cache_control: { type: "ephemeral" },
  };
  if (conversation.system.length) body.system = conversation.system.join("\n\n");
  if (toolList.length) {
    const choice = toolChoice(request.tool_choice, request.parallel_tool_calls);
    if (!choice) return null;
    body.tools = toolList;
    body.tool_choice = choice;
  }
  if (stop.length) body.stop_sequences = stop;
  if (format || effort) body.output_config = { ...(format ? { format } : {}), ...(effort ? { effort } : {}) };
  return body;
}

export function anthropicGatewayRequest(body: MessagesRequest) {
  return {
    provider: "anthropic",
    endpoint: "v1/messages",
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
      "cf-aig-collect-log": false,
      "cf-aig-no-wholesale": true,
      "cf-aig-request-timeout": body.stream ? ANTHROPIC_STREAM_FIRST_BYTE_MS : ANTHROPIC_ANSWER_MS,
    },
    query: body,
  };
}

const FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", max_tokens: "length", model_context_window_exceeded: "length", tool_use: "tool_calls", refusal: "content_filter" };

type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number };

function readUsage(usage: unknown, into: Usage): void {
  if (!isRecord(usage)) return;
  if (usage.input_tokens !== undefined) into.input = count(usage.input_tokens);
  if (usage.cache_creation_input_tokens !== undefined) into.cacheWrite = count(usage.cache_creation_input_tokens);
  if (usage.cache_read_input_tokens !== undefined) into.cacheRead = count(usage.cache_read_input_tokens);
  if (usage.output_tokens !== undefined) into.output = count(usage.output_tokens);
}

function openAiUsage(usage: Usage) {
  const prompt = usage.input + usage.cacheWrite + usage.cacheRead;
  return { prompt_tokens: prompt, completion_tokens: usage.output, total_tokens: prompt + usage.output, prompt_tokens_details: { cached_tokens: usage.cacheRead } };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function chatCompletion(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message) || message.type !== "message" || !Array.isArray(message.content) || message.stop_reason === "refusal") return null;
  const text: string[] = [];
  const toolCalls: Block[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "tool_use") toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
  }
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  readUsage(message.usage, usage);
  return {
    id: message.id,
    object: "chat.completion",
    created: nowSeconds(),
    model: message.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text.length ? text.join("") : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: FINISH[String(message.stop_reason)] ?? "stop",
    }],
    usage: openAiUsage(usage),
  };
}

export function chatCompletionStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const toolIndexes = new Map<number, number>();
  const toolsWithInput = new Set<number>();
  let head: Record<string, unknown> = { id: "", created: nowSeconds(), model: "" };
  let buffer = "";
  let opened = false;
  let failed = false;
  let done = false;
  const send = (controller: TransformStreamDefaultController<Uint8Array>, chunk: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  const delta = (controller: TransformStreamDefaultController<Uint8Array>, content: Record<string, unknown>, finish: string | null = null) => {
    const role = opened ? {} : { role: "assistant" };
    opened = true;
    send(controller, { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: { ...role, ...content }, finish_reason: finish }] });
  };
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (failed) return;
    failed = true;
    send(controller, { error: AI_BUSY_ERROR });
  };
  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (done) return;
    done = true;
    if (!opened) fail(controller);
    send(controller, { ...head, object: "chat.completion.chunk", choices: [], usage: openAiUsage(usage) });
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  const take = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.startsWith("data:") || done) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message)) {
          head = { id: event.message.id, created: nowSeconds(), model: event.message.model };
          readUsage(event.message.usage, usage);
        }
        return;
      case "content_block_start": {
        const block = isRecord(event.content_block) ? event.content_block : {};
        if (block.type === "text" && typeof block.text === "string" && block.text) delta(controller, { content: block.text });
        if (block.type === "tool_use" && typeof event.index === "number") {
          const index = toolIndexes.size;
          toolIndexes.set(event.index, index);
          delta(controller, { tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] });
        }
        return;
      }
      case "content_block_delta": {
        const change = isRecord(event.delta) ? event.delta : {};
        if (change.type === "text_delta" && typeof change.text === "string" && change.text) delta(controller, { content: change.text });
        const index = typeof event.index === "number" ? toolIndexes.get(event.index) : undefined;
        if (change.type === "input_json_delta" && index !== undefined && typeof change.partial_json === "string" && change.partial_json) {
          toolsWithInput.add(index);
          delta(controller, { tool_calls: [{ index, function: { arguments: change.partial_json } }] });
        }
        return;
      }
      case "content_block_stop": {
        const index = typeof event.index === "number" ? toolIndexes.get(event.index) : undefined;
        if (index !== undefined && !toolsWithInput.has(index)) {
          toolsWithInput.add(index);
          delta(controller, { tool_calls: [{ index, function: { arguments: "{}" } }] });
        }
        return;
      }
      case "message_delta": {
        readUsage(event.usage, usage);
        const reason = isRecord(event.delta) ? String(event.delta.stop_reason ?? "") : "";
        if (reason === "refusal" && !opened) return;
        if (reason) delta(controller, {}, FINISH[reason] ?? "stop");
        return;
      }
      case "message_stop":
        return finish(controller);
      case "error":
        return fail(controller);
      default:
        return;
    }
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
