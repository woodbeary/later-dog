import { AI_BUSY_ERROR, AI_MAX_OUTPUT_TOKENS, count, isRecord, type ChatRequest } from "./ai";

export const ANTHROPIC_VERSION = "2023-06-01";
export const CLAUDE_EFFORT = "medium";
export const CLAUDE_MAX_PLAIN_OUTPUT_TOKENS = 16_000;
export const CLAUDE_THINKING = "anthropic.thinking";
export const CLAUDE_REDACTED_THINKING = "anthropic.redacted_thinking";
export const CLAUDE_OPENING = "(The conversation so far follows.)";
export const CLAUDE_CONTINUE = "Continue.";
const EFFORTS: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high" };
const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Block = Record<string, unknown>;
type Turn = { role: "user" | "assistant"; content: Block[] };
type Thinking = { thinking: string; signature: string } | { data: string };

const seconds = () => Math.floor(Date.now() / 1000);
const words = (value: string): Block[] => (value ? [{ type: "text", text: value }] : []);
const finishOf = (reason: unknown) => (typeof reason === "string" ? FINISH[reason] ?? "stop" : "stop");

function imageBlock(url: unknown): Block[] {
  if (typeof url !== "string") return [];
  const inline = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url);
  if (inline) return IMAGE_TYPES.has(inline[1]!.toLowerCase()) ? [{ type: "image", source: { type: "base64", media_type: inline[1]!.toLowerCase(), data: inline[2] } }] : [];
  return /^https:\/\//i.test(url) ? [{ type: "image", source: { type: "url", url } }] : [];
}

function partsOf(content: unknown): Block[] {
  if (typeof content === "string") return words(content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): Block[] => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string") return words(part.text);
    if (part.type === "image_url") return imageBlock(isRecord(part.image_url) ? part.image_url.url : part.image_url);
    return [];
  });
}

const textOf = (content: unknown) => partsOf(content).flatMap((block) => (block.type === "text" ? [String(block.text)] : [])).join("\n\n");

function toolInput(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function thinkingBlocks(details: unknown): Block[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail): Block[] => {
    if (!isRecord(detail)) return [];
    if (detail.type === CLAUDE_THINKING && typeof detail.thinking === "string" && typeof detail.signature === "string" && detail.signature) {
      return [{ type: "thinking", thinking: detail.thinking, signature: detail.signature }];
    }
    if (detail.type === CLAUDE_REDACTED_THINKING && typeof detail.data === "string" && detail.data) return [{ type: "redacted_thinking", data: detail.data }];
    return [];
  });
}

function assistantBlocks(message: Record<string, unknown>): Block[] {
  const uses = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((call): Block[] => {
    if (!isRecord(call) || typeof call.id !== "string" || !call.id || !isRecord(call.function)) return [];
    const name = call.function.name;
    return typeof name === "string" && name ? [{ type: "tool_use", id: call.id, name, input: toolInput(call.function.arguments) }] : [];
  });
  const said = partsOf(message.content).filter((block) => block.type === "text");
  if (!said.length && !uses.length) return [];
  return [...thinkingBlocks(message.reasoning_details), ...said, ...uses];
}

function toolResult(message: Record<string, unknown>): Block[] {
  if (typeof message.tool_call_id !== "string" || !message.tool_call_id) return [];
  const content = partsOf(message.content);
  return [{ type: "tool_result", tool_use_id: message.tool_call_id, ...(content.length ? { content } : {}) }];
}

export function claudeMessages(messages: readonly unknown[]): { system: string; turns: Turn[] } {
  const system: string[] = [];
  const turns: Turn[] = [];
  const add = (role: Turn["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "system" || message.role === "developer") {
      const said = textOf(message.content);
      if (said) system.push(said);
    } else if (message.role === "assistant") add("assistant", assistantBlocks(message));
    else if (message.role === "tool") add("user", toolResult(message));
    else if (message.role === "user") add("user", partsOf(message.content));
  }
  for (const turn of turns) {
    if (turn.role === "user") turn.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: words(CLAUDE_OPENING) });
  if (turns.at(-1)?.role === "assistant") turns.push({ role: "user", content: words(CLAUDE_CONTINUE) });
  return { system: system.join("\n\n"), turns };
}

function claudeTools(tools: unknown): Block[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool): Block[] => {
    const described = isRecord(tool) && isRecord(tool.function) ? tool.function : null;
    if (!described || typeof described.name !== "string" || !described.name) return [];
    const schema = isRecord(described.parameters) && described.parameters.type === "object" ? described.parameters : { type: "object", properties: {} };
    const about = typeof described.description === "string" && described.description ? { description: described.description } : {};
    return [{ name: described.name, ...about, input_schema: schema }];
  });
}

function toolChoice(choice: unknown, parallel: unknown): Block | undefined {
  if (choice === "none") return { type: "none" };
  return parallel === false ? { type: "auto", disable_parallel_tool_use: true } : undefined;
}

export function claudeBody(request: ChatRequest, model: string): Record<string, unknown> | null {
  const { system, turns } = claudeMessages(Array.isArray(request.messages) ? request.messages : []);
  if (!turns.length) return null;
  const tools = claudeTools(request.tools);
  const choice = tools.length ? toolChoice(request.tool_choice, request.parallel_tool_calls) : undefined;
  const effort = typeof request.reasoning_effort === "string" ? EFFORTS[request.reasoning_effort] ?? CLAUDE_EFFORT : CLAUDE_EFFORT;
  const stops = (Array.isArray(request.stop) ? request.stop : [request.stop]).filter((stop): stop is string => typeof stop === "string" && stop.length > 0);
  const asked = typeof request.max_tokens === "number" ? request.max_tokens : AI_MAX_OUTPUT_TOKENS;
  return {
    model,
    max_tokens: request.stream ? asked : Math.min(asked, CLAUDE_MAX_PLAIN_OUTPUT_TOKENS),
    ...(system ? { system } : {}),
    messages: turns,
    ...(tools.length ? { tools } : {}),
    ...(choice ? { tool_choice: choice } : {}),
    ...(stops.length ? { stop_sequences: stops } : {}),
    output_config: { effort },
    cache_control: { type: "ephemeral" },
    stream: request.stream,
  };
}

export function claudeRequest(body: Record<string, unknown>, key: string) {
  return {
    provider: "anthropic",
    endpoint: "v1/messages",
    headers: {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
      "cf-aig-collect-log": false,
      "cf-aig-request-timeout": 120_000,
    },
    query: body,
  };
}

export function claudeUsage(usage: unknown) {
  const reported = isRecord(usage) ? usage : {};
  const read = count(reported.cache_read_input_tokens);
  const prompt = count(reported.input_tokens) + count(reported.cache_creation_input_tokens) + read;
  const output = count(reported.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: read } };
}

const detailOf = (block: Thinking) => ("data" in block
  ? { type: CLAUDE_REDACTED_THINKING, data: block.data }
  : { type: CLAUDE_THINKING, thinking: block.thinking, signature: block.signature });

export function claudeCompletion(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message) || message.type !== "message" || !Array.isArray(message.content)) return null;
  let said = "";
  const calls: Record<string, unknown>[] = [];
  const details: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") said += block.text;
    else if (block.type === "tool_use") calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    else if (block.type === "thinking") details.push(detailOf({ thinking: String(block.thinking ?? ""), signature: String(block.signature ?? "") }));
    else if (block.type === "redacted_thinking") details.push(detailOf({ data: String(block.data ?? "") }));
  }
  return {
    id: message.id,
    object: "chat.completion",
    created: seconds(),
    model: message.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: said || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}), ...(details.length ? { reasoning_details: details } : {}) },
      finish_reason: finishOf(message.stop_reason),
    }],
    usage: claudeUsage(message.usage),
  };
}

export function claudeChunks(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = "";
  let head = { id: "", created: seconds(), model: "" };
  let usage: Record<string, unknown> = {};
  let finish = "stop";
  let ended = false;
  let failed = false;
  const tools = new Map<number, number>();
  const thinking = new Map<number, Thinking>();
  type Out = TransformStreamDefaultController<Uint8Array>;
  const frame = (controller: Out, chunk: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  const send = (controller: Out, delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    frame(controller, { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] });
  const close = (controller: Out, complete: boolean) => {
    if (ended) return;
    ended = true;
    if (complete) send(controller, {}, { finish_reason: finish });
    if (Object.keys(usage).length) frame(controller, { ...head, object: "chat.completion.chunk", choices: [], usage: claudeUsage(usage) });
    if (!complete && !failed) frame(controller, { error: AI_BUSY_ERROR });
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  const take = (line: string, controller: Out) => {
    if (ended || !line.startsWith("data:")) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    const index = Number(event.index);
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      head = { id: String(message.id ?? ""), created: head.created, model: String(message.model ?? "") };
      if (isRecord(message.usage)) usage = { ...message.usage };
      send(controller, { role: "assistant", content: "" });
    } else if (event.type === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      if (block.type === "tool_use") {
        tools.set(index, tools.size);
        send(controller, { tool_calls: [{ index: tools.get(index), id: block.id, type: "function", function: { name: block.name, arguments: "" } }] });
      } else if (block.type === "thinking") thinking.set(index, { thinking: String(block.thinking ?? ""), signature: String(block.signature ?? "") });
      else if (block.type === "redacted_thinking") thinking.set(index, { data: String(block.data ?? "") });
      else if (block.type === "text" && typeof block.text === "string" && block.text) send(controller, { content: block.text });
    } else if (event.type === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      const thought = thinking.get(index);
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) send(controller, { content: delta.text });
      else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json && tools.has(index)) {
        send(controller, { tool_calls: [{ index: tools.get(index), function: { arguments: delta.partial_json } }] });
      } else if (delta.type === "thinking_delta" && thought && "thinking" in thought && typeof delta.thinking === "string") thought.thinking += delta.thinking;
      else if (delta.type === "signature_delta" && thought && "signature" in thought && typeof delta.signature === "string") thought.signature += delta.signature;
    } else if (event.type === "content_block_stop") {
      const thought = thinking.get(index);
      if (thought) {
        thinking.delete(index);
        send(controller, { reasoning_details: [detailOf(thought)] });
      }
    } else if (event.type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) finish = finishOf(delta.stop_reason);
      if (isRecord(event.usage)) usage = { ...usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, value]) => typeof value === "number")) };
    } else if (event.type === "message_stop") close(controller, true);
    else if (event.type === "error") {
      failed = true;
      frame(controller, { error: AI_BUSY_ERROR });
      close(controller, false);
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
      close(controller, false);
    },
  }));
}
