import type { Refusal } from "./auth";
import { AI_TOKENS_PER_DAY, AI_TOKENS_TOTAL_PER_DAY, AI_TRIAL_TOKENS_PER_DAY, GROK_TOKENS_PER_DAY, GROK_TOKENS_TOTAL_PER_DAY, type ChatRequest } from "./ai";
import type { UsageKind } from "./decide";
import type { Tier } from "./gateway";
import type { TrialRegistry } from "./trial-registry";
import type { Spend } from "./usage-cost";

export const RESERVE_BYTES_PER_TOKEN = 3;
export const SIZE_CHECK_BYTES_PER_TOKEN = 4;
export const IMAGE_TOKENS_ESTIMATE = 2_000;

export type TokenBudget = { kind: UsageKind; perKey: number; perFullKey: number; total: number };

export const AI_BUDGET: TokenBudget = { kind: "ai_tokens", perKey: AI_TRIAL_TOKENS_PER_DAY, perFullKey: AI_TOKENS_PER_DAY, total: AI_TOKENS_TOTAL_PER_DAY };
export const GROK_BUDGET: TokenBudget = { kind: "grok_tokens", perKey: 0, perFullKey: GROK_TOKENS_PER_DAY, total: GROK_TOKENS_TOTAL_PER_DAY };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function countedPart(part: unknown, media: { count: number }): unknown {
  if (!isRecord(part) || part.type === "text") return part;
  media.count += 1;
  return part.type === "image_url" ? { type: "image_url" } : part;
}

function countedMessage(message: unknown, media: { count: number }): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((part) => countedPart(part, media)) };
}

export function promptTokens(request: ChatRequest, bytesPerToken = RESERVE_BYTES_PER_TOKEN): number {
  const media = { count: 0 };
  const messages = Array.isArray(request.messages) ? request.messages.map((message) => countedMessage(message, media)) : request.messages;
  const text = JSON.stringify({ ...request, messages });
  return Math.ceil(new TextEncoder().encode(text).byteLength / bytesPerToken) + media.count * IMAGE_TOKENS_ESTIMATE;
}

export function chatEstimate(request: ChatRequest): { prompt: number; reserve: number } {
  const output = typeof request.max_tokens === "number" ? request.max_tokens : 0;
  return { prompt: promptTokens(request, SIZE_CHECK_BYTES_PER_TOKEN), reserve: promptTokens(request, RESERVE_BYTES_PER_TOKEN) + output };
}

export interface Reservation {
  tier: Tier;
  reserved: number;
  settle(used: number, spend?: Spend | null): Promise<void>;
  refund(): Promise<void>;
}

export async function reserveTokens(
  registry: DurableObjectStub<TrialRegistry>,
  keySha256: string,
  budget: TokenBudget,
  amount: number,
): Promise<{ ok: true; reservation: Reservation } | { ok: false; refusal: Refusal }> {
  const hold = await registry.reserveUsage({ keySha256, amount, ...budget });
  if (!hold.ok) return { ok: false, refusal: hold.refusal };
  let open = true;
  const close = async (used: number, spend?: Spend | null) => {
    if (!open) return;
    open = false;
    await registry.settleUsage({ keySha256, kind: budget.kind, day: hold.day, reserved: hold.amount, used, ...(spend ? { spend } : {}) });
  };
  return {
    ok: true,
    reservation: {
      tier: hold.tier,
      reserved: hold.amount,
      settle: (used, spend) => close(used > 0 ? used : hold.amount, spend),
      refund: () => close(0),
    },
  };
}

export function jointReservation(main: Reservation, ...others: Reservation[]): Reservation {
  const all = [main, ...others];
  return {
    tier: main.tier,
    reserved: main.reserved,
    settle: async (used, spend) => {
      await Promise.all([main.settle(used, spend), ...others.map((reservation) => reservation.settle(used))]);
    },
    refund: async () => {
      await Promise.all(all.map((reservation) => reservation.refund()));
    },
  };
}
