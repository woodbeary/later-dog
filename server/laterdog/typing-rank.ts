import type { Decider } from "../decider/index.ts";
import type { DeciderJob } from "../decider/types.ts";
import { plainContext } from "./typing-context.ts";

export const TYPING_RANK_JOB = "typingSuggestions" as DeciderJob;
export const TYPING_RANK_TIMEOUT_MS = 250;
export const TYPING_RANK_MIN_CANDIDATES = 2;
export const TYPING_RANK_MAX_CANDIDATES = 8;
export const TYPING_RANK_MIN_CONFIDENCE = 0.5;
const CANDIDATE_CHARS = 120;

export const TYPING_RANK_QUESTION =
  "Which of these is the most likely way the person finishes what they are typing? Choose the one that best fits what they typed and the last message.";

export interface RankInput {
  typed: string;
  lastDogMessage: string;
  candidates: string[];
}

export type RankResult = { ok: true; index: number; ms: number } | { ok: false; reason: "too-few" | "unsure" | "unavailable" };

export interface RankCandidate {
  text: string;
  index: number;
}

export function cleanCandidates(candidates: readonly string[]): RankCandidate[] {
  const seen = new Set<string>();
  const out: RankCandidate[] = [];
  candidates.forEach((candidate, index) => {
    const text = plainContext(candidate, CANDIDATE_CHARS);
    if (!text || seen.has(text) || out.length >= TYPING_RANK_MAX_CANDIDATES) return;
    seen.add(text);
    out.push({ text, index });
  });
  return out;
}

export async function rankCandidates(decider: Pick<Decider, "choose">, input: RankInput, signal?: AbortSignal): Promise<RankResult> {
  const candidates = cleanCandidates(input.candidates);
  if (candidates.length < TYPING_RANK_MIN_CANDIDATES) return { ok: false, reason: "too-few" };
  const options = Object.fromEntries(candidates.map((candidate, position) => [`c${position}`, candidate.text]));
  const result = await decider.choose(
    TYPING_RANK_JOB,
    { typed: plainContext(input.typed, 300), last_message: plainContext(input.lastDogMessage, 400) },
    { instructions: TYPING_RANK_QUESTION, options },
    { timeoutMs: TYPING_RANK_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  if (!result.ok) return { ok: false, reason: "unavailable" };
  const position = Number(result.answers.choice.slice(1));
  const chosen = Number.isInteger(position) ? candidates[position] : undefined;
  if (!chosen) return { ok: false, reason: "unavailable" };
  if (result.answers.pTop < TYPING_RANK_MIN_CONFIDENCE) return { ok: false, reason: "unsure" };
  return { ok: true, index: chosen.index, ms: result.latencyMs };
}
