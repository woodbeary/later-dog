import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import type { Message } from "../store.ts";

export const DESK_BRAIN_PATH = "/api/cloud/desk/brain";
export const DESK_SKEW_S = 120;
export const DESK_REPLY_MAX_CHARS = 32_000;
const NONCE_MS = 5 * 60_000;
const MAX_NONCES = 2_000;
const PROMPTS_KEPT = 50;
const PROMPT_MAX_CHARS = 160_000;
const TRANSCRIPT_LINES = 24;
const TRANSCRIPT_MAX_CHARS = 24_000;

export interface DeskPrompt {
  instanceId: string;
  model: string;
  system: string;
  at: number;
}

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

export interface DeskReply {
  text: string;
  model: string;
}

type Headers = Record<string, string | string[] | undefined>;

export function deskSignature(secret: string, parts: readonly string[]): string {
  return createHmac("sha256", secret).update(["v1", ...parts].join("\n")).digest("base64url");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const header = (headers: Headers, name: string): string => {
  const value = headers[name];
  return typeof value === "string" ? value : "";
};

export function createDeskVerifier(options: { secret: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const nonces = new Map<string, number>();
  return (headers: Headers, parts: readonly string[]): boolean => {
    const timestamp = header(headers, "x-laterdog-cloud-timestamp");
    const nonce = header(headers, "x-laterdog-cloud-nonce");
    const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(header(headers, "x-laterdog-cloud-signature"))?.[1];
    if (!presented || !/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
    const expected = Buffer.from(deskSignature(options.secret, [timestamp, nonce, ...parts]), "base64url");
    const given = Buffer.from(presented, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const at = now();
    if (Math.abs(at / 1000 - Number(timestamp)) > DESK_SKEW_S) return false;
    for (const [seen, until] of nonces) if (until <= at) nonces.delete(seen);
    if (nonces.has(nonce) || nonces.size >= MAX_NONCES) return false;
    nonces.set(nonce, at + NONCE_MS);
    return true;
  };
}

export function createDeskPrompts(file: string, now: () => number = Date.now) {
  let prompts: Record<string, DeskPrompt> = {};
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) prompts = saved as Record<string, DeskPrompt>;
  } catch {
    prompts = {};
  }
  return {
    remember(threadId: string, prompt: Omit<DeskPrompt, "at">): void {
      if (!prompt.system || prompt.system.length > PROMPT_MAX_CHARS) return;
      const known = prompts[threadId];
      if (known && known.system === prompt.system && known.model === prompt.model && known.instanceId === prompt.instanceId) return;
      const kept = Object.entries({ ...prompts, [threadId]: { ...prompt, at: now() } })
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, PROMPTS_KEPT);
      prompts = Object.fromEntries(kept);
      writeFileAtomic(file, `${JSON.stringify(prompts)}\n`, { mode: 0o600 });
    },
    get(threadId: string): DeskPrompt | undefined {
      return prompts[threadId];
    },
  };
}

export function deskTranscript(path: readonly Message[]): DeskDog["transcript"] {
  const lines: DeskDog["transcript"] = [];
  let chars = 0;
  for (let index = path.length - 1; index >= 0 && lines.length < TRANSCRIPT_LINES; index--) {
    const message = path[index]!;
    if (message.kind !== "text" || !message.text?.trim()) continue;
    if (chars + message.text.length > TRANSCRIPT_MAX_CHARS) break;
    chars += message.text.length;
    lines.unshift({ role: message.role === "user" ? "user" : "assistant", content: message.text });
  }
  return lines;
}

export function deskDogs(input: {
  bots: ReadonlyArray<{ id: string; name: string; threadId: string; modelSelection: { instanceId: string; model: string } }>;
  prompt: (threadId: string) => DeskPrompt | undefined;
  path: (threadId: string) => readonly Message[];
  leaf: (threadId: string) => string | null;
  answers: readonly string[];
  busy: (botId: string) => boolean;
}): DeskDog[] {
  return input.bots.flatMap((bot) => {
    const { instanceId, model } = bot.modelSelection;
    const prompt = input.prompt(bot.threadId);
    if (!input.answers.includes(instanceId) || !prompt || prompt.instanceId !== instanceId || input.busy(bot.id)) return [];
    return [{
      botId: bot.id,
      threadId: bot.threadId,
      name: bot.name,
      instanceId,
      model: model || prompt.model,
      system: prompt.system,
      transcript: deskTranscript(input.path(bot.threadId)),
      leafId: input.leaf(bot.threadId),
    }];
  });
}

export function deskReplyFrom(input: {
  verify: (headers: Headers, parts: readonly string[]) => boolean;
  headers: Headers;
  path: string;
  sendId: string | undefined;
  reply: unknown;
}): DeskReply | null {
  const reply = input.reply as { text?: unknown; model?: unknown } | null | undefined;
  if (!reply || typeof reply !== "object" || typeof reply.text !== "string" || typeof reply.model !== "string") return null;
  if (!input.sendId || !reply.text.trim() || reply.text.length > DESK_REPLY_MAX_CHARS) return null;
  if (!input.verify(input.headers, ["POST", input.path, input.sendId, sha256Hex(reply.text)])) return null;
  return { text: reply.text, model: reply.model };
}
