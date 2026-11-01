import { z } from "zod";
import { TAKEOVER_REASONS } from "../../shared/takeover.ts";
import { WITHHELD_MEMBERS } from "./computer-use-actions.ts";
import { LOOP_SECURE_FORM_TOOLS } from "./computer-use-secure-form.ts";

export const COMPUTER_USE_MODEL = "claude-opus-5-5";
export const COMPUTER_USE_EFFORT = "medium";
export const COMPUTER_TOOLSET_TYPE = "computer_toolset_20260801";
export const ANTHROPIC_VERSION = "2023-06-01";
export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const MAX_OUTPUT_TOKENS = 16_000;
export const MESSAGES_TIMEOUT_MS = 10 * 60_000;
export const RETRY_AFTER_MS = 2_000;
export const TAKEOVER_TOOL_NAME = "request_takeover";

export type ContentBlock = Record<string, unknown> & { type: string };
export interface MessageTurn {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface MessagesRequest {
  system: string;
  messages: MessageTurn[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface MessagesReply {
  model: string;
  stopReason: string | null;
  content: ContentBlock[];
  usage: TokenUsage;
}

export interface MessagesApi {
  readonly model: string;
  create(request: MessagesRequest, signal: AbortSignal): Promise<MessagesReply>;
}

export const TAKEOVER_TOOL = {
  name: TAKEOVER_TOOL_NAME,
  description: "Hand the screen to the person for one step only they can do: a sign-in or code you were not given, a passkey, a CAPTCHA, a payment, or a final yes. Open the exact page and fill in everything else first. later.dog shows them a Take over button and tells you when they hand the screen back.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      step: { type: "string", description: "The one step, in a few plain words, for example \"Sign in to the clinic portal\"." },
      reason: { type: "string", enum: [...TAKEOVER_REASONS] },
    },
    required: ["step", "reason"],
    additionalProperties: false,
  },
} as const;

export function messagesBody(request: MessagesRequest): Record<string, unknown> {
  return {
    model: COMPUTER_USE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    output_config: { effort: COMPUTER_USE_EFFORT },
    cache_control: { type: "ephemeral" },
    system: request.system,
    tools: [
      { type: COMPUTER_TOOLSET_TYPE, configs: Object.fromEntries(WITHHELD_MEMBERS.map((member) => [member, { enabled: false }])) },
      TAKEOVER_TOOL,
      ...LOOP_SECURE_FORM_TOOLS,
    ],
    messages: request.messages,
  };
}

const count = z.number().int().min(0);
const replySchema = z.object({
  model: z.string().min(1).max(200),
  stop_reason: z.string().max(100).nullable(),
  content: z.array(z.object({ type: z.string().min(1).max(100) }).passthrough()).max(1000),
  usage: z.object({
    input_tokens: count,
    output_tokens: count,
    cache_read_input_tokens: count.nullish(),
    cache_creation_input_tokens: count.nullish(),
  }).passthrough(),
}).passthrough();
const failureSchema = z.object({ error: z.object({ type: z.string().optional(), message: z.string().optional() }) });

export class MessagesApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "MessagesApiError";
    this.httpStatus = httpStatus;
  }
}

export function parseReply(body: unknown): MessagesReply {
  const parsed = replySchema.safeParse(body);
  if (!parsed.success) throw new MessagesApiError("Claude's API returned an answer later.dog could not read.", 502);
  const { usage } = parsed.data;
  return {
    model: parsed.data.model,
    stopReason: parsed.data.stop_reason,
    content: parsed.data.content as ContentBlock[],
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0 },
  };
}

async function failure(response: Response): Promise<MessagesApiError> {
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  const parsed = failureSchema.safeParse(body);
  const theirs = parsed.success ? [parsed.data.error.type, parsed.data.error.message].filter(Boolean).join(": ").slice(0, 300) : "";
  return new MessagesApiError(`Claude's API answered ${response.status}${theirs ? ` (${theirs})` : ""}.`, response.status);
}

export function fixtureMessagesUrl(raw: string | undefined): string {
  if (!raw?.trim()) return MESSAGES_URL;
  let url: URL | null = null;
  try { url = new URL(raw.trim()); } catch { url = null; }
  if (!url || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("LATERDOG_ANTHROPIC_URL may only point at a loopback fixture (http://127.0.0.1:PORT/...); real calls always go to Claude's API.");
  }
  return url.href;
}

export function anthropicMessages(apiKey: string, options: { fetch?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; url?: string } = {}): MessagesApi {
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) throw new Error("ANTHROPIC_API_KEY does not look like a Claude API key (they start with sk-ant-).");
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  return {
    model: COMPUTER_USE_MODEL,
    async create(request, signal) {
      const body = JSON.stringify(messagesBody(request));
      for (let attempt = 0; ; attempt++) {
        const response = await fetchImpl(options.url ?? MESSAGES_URL, {
          method: "POST",
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(MESSAGES_TIMEOUT_MS)]),
          headers: { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, "x-api-key": apiKey },
        });
        if (response.ok) return parseReply(await response.json());
        const error = await failure(response);
        if (attempt > 0 || (response.status !== 429 && response.status < 500)) throw error;
        await sleep(RETRY_AFTER_MS, signal);
      }
    },
  };
}
