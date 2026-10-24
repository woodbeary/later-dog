import { inlineReasoning } from "../../../../server/laterdog/inline-reasoning.ts";
import { base64url, hex, hmacSha256, randomToken, sha256 } from "./encoding.ts";
import type { QueuedSend } from "./desk.ts";

export const DESK_BRAIN_PATH = "/api/cloud/desk/brain";
export const DESK_BRAIN_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
export const DESK_ANSWER_TIMEOUT_MS = 45_000;
export const DESK_TEXT_MAX_CHARS = 8_000;
export const WAKE_TOOL = "wake_up";
const ANSWERABLE_FIELDS = new Set(["text", "sendId", "threadId"]);
const DESK_NOTE = `Your computer is starting up, so you have no tools for this one reply. If the message is conversation you can answer from what you already know, answer it as you normally would. If answering needs your computer, files, apps, the web, anything you have not been shown here, or any other tool, call ${WAKE_TOOL} and write nothing else.`;

export interface DeskDog {
  botId: string;
  threadId: string;
  name: string;
  instanceId: string;
  model: string;
  system: string;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  leafId: string | null;
}

export interface DeskBrain {
  at: number;
  dogs: DeskDog[];
}

export type DeskOutcome = { kind: "reply"; text: string } | { kind: "home"; reason: string };

export async function deskSignedHeaders(secret: string, parts: readonly string[], now = Date.now()): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomToken(24);
  return {
    "x-laterdog-cloud-timestamp": timestamp,
    "x-laterdog-cloud-nonce": nonce,
    "x-laterdog-cloud-signature": `v1=${base64url(await hmacSha256(secret, ["v1", timestamp, nonce, ...parts].join("\n")))}`,
  };
}

export async function signedBrainRequest(origin: string, secret: string, now = Date.now()): Promise<Request> {
  return new Request(`${origin}${DESK_BRAIN_PATH}`, { headers: await deskSignedHeaders(secret, ["GET", DESK_BRAIN_PATH], now) });
}

const isText = (value: unknown): value is string => typeof value === "string";

function deskDog(input: unknown): DeskDog | null {
  if (!input || typeof input !== "object") return null;
  const dog = input as Record<string, unknown>;
  if (![dog.botId, dog.threadId, dog.name, dog.instanceId, dog.model, dog.system].every(isText) || !(dog.system as string)) return null;
  if (!Array.isArray(dog.transcript)) return null;
  const transcript = dog.transcript.flatMap((line): DeskDog["transcript"] => {
    const { role, content } = (line ?? {}) as { role?: unknown; content?: unknown };
    return (role === "user" || role === "assistant") && isText(content) ? [{ role, content }] : [];
  });
  return {
    botId: dog.botId as string,
    threadId: dog.threadId as string,
    name: dog.name as string,
    instanceId: dog.instanceId as string,
    model: dog.model as string,
    system: dog.system as string,
    transcript,
    leafId: isText(dog.leafId) ? dog.leafId : null,
  };
}

export function parseBrain(input: unknown): DeskBrain | null {
  if (!input || typeof input !== "object") return null;
  const { at, dogs } = input as { at?: unknown; dogs?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at) || !Array.isArray(dogs)) return null;
  return { at, dogs: dogs.flatMap((dog) => deskDog(dog) ?? []) };
}

const BOT_SEND = /^\/api\/bots\/([^/]+)\/messages$/;

export function sentText(queued: QueuedSend): { text: string; sendId: string } | null {
  try {
    const body = JSON.parse(queued.body) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Object.keys(body).some((field) => !ANSWERABLE_FIELDS.has(field))) return null;
    if (!isText(body.text) || !body.text.trim() || body.text.length > DESK_TEXT_MAX_CHARS || !isText(body.sendId)) return null;
    return { text: body.text, sendId: body.sendId };
  } catch {
    return null;
  }
}

export function answerable(queued: QueuedSend, brain: DeskBrain | null, now: number): DeskDog | null {
  if (!brain || now - brain.at > DESK_BRAIN_KEPT_MS) return null;
  const botId = BOT_SEND.exec(queued.path)?.[1];
  const dog = botId ? brain.dogs.find((candidate) => candidate.botId === botId) : undefined;
  if (!dog || (queued.threadId !== undefined && queued.threadId !== dog.threadId)) return null;
  return sentText(queued) ? dog : null;
}

export function deskConversation(dog: DeskDog, earlier: ReadonlyArray<{ text: string; reply: string }>, text: string) {
  return [
    { role: "system", content: `${dog.system}\n\n${DESK_NOTE}` },
    ...dog.transcript,
    ...earlier.flatMap((exchange) => [{ role: "user", content: exchange.text }, { role: "assistant", content: exchange.reply }]),
    { role: "user", content: text },
  ];
}

const WAKE_DEFINITION = {
  type: "function",
  function: {
    name: WAKE_TOOL,
    description: "Start your computer so you can use your tools for this message.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export async function answerOnDesk(input: {
  api: string;
  key: string;
  dog: DeskDog;
  messages: ReturnType<typeof deskConversation>;
  onText: (delta: string) => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<DeskOutcome> {
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${input.api}/ai/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: input.dog.model, messages: input.messages, stream: true, tools: [WAKE_DEFINITION] }),
      signal: input.signal ?? AbortSignal.timeout(DESK_ANSWER_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "home", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok || !response.body) return { kind: "home", reason: `the free model answered ${response.status}` };
  let reply = "";
  let wakes = false;
  const split = inlineReasoning(true, (text, stream) => {
    if (stream !== "assistant_text" || wakes) return;
    reply += text;
    input.onText(text);
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: { model?: unknown; choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ function?: { name?: unknown } }> } }> };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        split.answeredBy(chunk.model);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.tool_calls?.some((call) => call.function?.name === WAKE_TOOL)) wakes = true;
        if (typeof delta?.content === "string") split.content(delta.content);
      }
    }
    split.end();
  } catch (error) {
    return { kind: "home", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    reader.releaseLock();
  }
  if (wakes) return { kind: "home", reason: "the dog needs its computer" };
  const text = reply.trim();
  return text ? { kind: "reply", text } : { kind: "home", reason: "the free model said nothing" };
}

export async function deskReplyHeaders(secret: string, path: string, sendId: string, text: string, now = Date.now()): Promise<Record<string, string>> {
  return deskSignedHeaders(secret, ["POST", path, sendId, hex(await sha256(text))], now);
}
