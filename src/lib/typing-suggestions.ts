import { looksSecret } from "../../shared/typing-secrets";

export const PHRASE_STORE_KEY = "laterdog.typingPhrases.v1";
export const MAX_PHRASES = 300;
export const MIN_PHRASE_WORDS = 3;
export const MAX_PHRASE_WORDS = 14;
export const MAX_PHRASE_CHARS = 120;
export const MIN_TYPED_CHARS = 3;
export const MAX_CANDIDATES = 8;
export const FAST_PAUSE_MS = 120;
export const MODEL_PAUSE_MS = 400;
export const RANK_BUDGET_MS = 250;
export const MODEL_BUDGET_MS = 1_800;
export const RECENT_MESSAGES = 6;
export const RECENT_MESSAGE_CHARS = 400;
export const PHRASING_SAMPLES = 3;

export interface Phrase {
  text: string;
  count: number;
  last: number;
}

export type PhraseBook = readonly Phrase[];

export type CandidateKind = "phrase" | "command" | "dog";

export interface Candidate {
  kind: CandidateKind;
  completion: string;
  matched: number;
  weight: number;
}

export interface SuggestionPool {
  phrases: PhraseBook;
  dogNames: readonly string[];
  commands: readonly string[];
}

export interface TypingContext {
  dog: string;
  messages: Array<{ role: "person" | "dog"; text: string }>;
  phrasing: string[];
}

const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;
const TRAILING_STOPS = /[.!?\s]+$/;

function storageOf(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadPhrases(storage: Pick<Storage, "getItem"> | undefined = storageOf()): PhraseBook {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PHRASE_STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is Phrase =>
      Boolean(entry) && typeof entry.text === "string" && Number.isFinite(entry.count) && Number.isFinite(entry.last) && !looksSecret(entry.text),
    ).slice(0, MAX_PHRASES);
  } catch {
    return [];
  }
}

export function savePhrases(book: PhraseBook, storage: Pick<Storage, "setItem"> | undefined = storageOf()): void {
  try {
    storage?.setItem(PHRASE_STORE_KEY, JSON.stringify(book));
  } catch {
    return;
  }
}

export function forgetPhrases(storage: Pick<Storage, "removeItem"> | undefined = storageOf()): void {
  try {
    storage?.removeItem(PHRASE_STORE_KEY);
  } catch {
    return;
  }
}

function worthKeeping(segment: string): boolean {
  if (segment.length > MAX_PHRASE_CHARS || /[<>]|:\/\/|`/.test(segment) || segment.startsWith("/")) return false;
  const words = segment.split(/\s+/).filter(Boolean).length;
  return words >= MIN_PHRASE_WORDS && words <= MAX_PHRASE_WORDS && !looksSecret(segment);
}

export function learnPhrases(book: PhraseBook, sent: string, now: number): PhraseBook {
  const next = book.map((phrase) => ({ ...phrase }));
  for (const raw of sent.split(SENTENCE_BREAK)) {
    const segment = raw.trim().replace(TRAILING_STOPS, "");
    if (!worthKeeping(segment)) continue;
    const known = next.find((phrase) => phrase.text.toLowerCase() === segment.toLowerCase());
    if (known) {
      known.count += 1;
      known.last = now;
    } else {
      next.push({ text: segment, count: 1, last: now });
    }
  }
  return next.sort((a, b) => b.count - a.count || b.last - a.last).slice(0, MAX_PHRASES);
}

export function learnSent(sent: string, now = Date.now(), storage?: Storage): void {
  const target = storage ?? storageOf();
  savePhrases(learnPhrases(loadPhrases(target), sent, now), target);
}

function currentSegment(text: string): string {
  const breaks = [...text.matchAll(/[.!?]\s+|\n/g)];
  const last = breaks.at(-1);
  return last ? text.slice(last.index + last[0].length) : text;
}

function tailStarts(segment: string): number[] {
  const starts = [0];
  for (const match of segment.matchAll(/\s+(?=\S)/g)) starts.push(match.index + match[0].length);
  return starts;
}

export function fastCandidates(text: string, pool: SuggestionPool): Candidate[] {
  const segment = currentSegment(text);
  if (segment.trim().length < MIN_TYPED_CHARS - 1) return [];
  const found = new Map<string, Candidate>();
  const keep = (candidate: Candidate) => {
    const known = found.get(candidate.completion);
    if (!known || candidate.matched > known.matched) found.set(candidate.completion, candidate);
  };
  const lowered = segment.toLowerCase();
  if (segment.trim().length >= MIN_TYPED_CHARS) {
    for (const start of tailStarts(segment)) {
      const tail = segment.slice(start);
      if (tail.trim().length < MIN_TYPED_CHARS) continue;
      const needle = lowered.slice(start);
      for (const phrase of pool.phrases) {
        if (phrase.text.length <= tail.length || !phrase.text.toLowerCase().startsWith(needle)) continue;
        keep({ kind: "phrase", completion: phrase.text.slice(tail.length), matched: tail.length, weight: phrase.count });
      }
    }
  }
  const word = /(?:^|\s)([^\s@/]+)$/.exec(segment)?.[1] ?? "";
  if (word.length >= 2) {
    for (const name of pool.dogNames) {
      if (name.length > word.length && name.toLowerCase().startsWith(word.toLowerCase())) {
        keep({ kind: "dog", completion: name.slice(word.length), matched: word.length, weight: 0 });
      }
    }
  }
  if (segment.startsWith("/") && !/\s/.test(segment) && segment.length >= 2) {
    for (const command of pool.commands) {
      if (command.length > segment.length && command.toLowerCase().startsWith(lowered)) {
        keep({ kind: "command", completion: `${command.slice(segment.length)} `, matched: segment.length, weight: 0 });
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.matched - a.matched || b.weight - a.weight || a.completion.length - b.completion.length)
    .slice(0, MAX_CANDIDATES);
}

export interface FastAnswer {
  best: Candidate | null;
  tied: Candidate[];
}

export function pickFast(candidates: readonly Candidate[]): FastAnswer {
  const best = candidates[0] ?? null;
  if (!best) return { best: null, tied: [] };
  const tied = candidates.filter((candidate) => candidate.matched === best.matched && candidate.kind === best.kind);
  return { best, tied: tied.length > 1 ? tied : [] };
}

export interface ChatLine {
  role: "user" | "bot";
  kind: string;
  text?: string;
  secureForm?: unknown;
  secret?: unknown;
  card?: unknown;
}

export function buildTypingContext(lines: readonly ChatLine[], dog: string, book: PhraseBook): TypingContext {
  const messages = lines
    .filter((line) => line.kind === "text" && typeof line.text === "string" && line.text.trim() && !line.secureForm && !line.secret && !line.card)
    .slice(-RECENT_MESSAGES)
    .map((line) => ({ role: line.role === "user" ? ("person" as const) : ("dog" as const), text: (line.text as string).slice(0, RECENT_MESSAGE_CHARS) }));
  const phrasing = [...book].sort((a, b) => b.last - a.last).slice(0, PHRASING_SAMPLES).map((phrase) => phrase.text);
  return { dog, messages, phrasing };
}

export interface BlockedBy {
  recording: boolean;
  listening: boolean;
  locked: boolean;
  approval: boolean;
  secureFormOpen: boolean;
  picker: boolean;
  composing: boolean;
  field: Element | null;
}

const SECURE_AUTOCOMPLETE = /\b(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)\b/i;

export function isSecureField(field: Element | null): boolean {
  if (!field || typeof field.getAttribute !== "function") return false;
  if (field.tagName === "INPUT" && (field.getAttribute("type") ?? "").toLowerCase() === "password") return true;
  const autocomplete = field.getAttribute("autocomplete") ?? "";
  if (SECURE_AUTOCOMPLETE.test(autocomplete)) return true;
  return typeof field.closest === "function" && field.closest("[data-secure-form],[data-secure-field]") !== null;
}

export function suggestionsBlocked(by: BlockedBy): boolean {
  return by.recording || by.listening || by.locked || by.approval || by.secureFormOpen || by.picker || by.composing || isSecureField(by.field);
}

export type ModelAnswer = { completion: string; source: "cloud" | "cloudflare"; ms: number } | null;

export async function askModel(
  prefix: string,
  context: TypingContext,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ModelAnswer> {
  if (looksSecret(prefix)) return null;
  try {
    const res = await fetcher("/api/typing/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix, dog: context.dog, messages: context.messages, phrasing: context.phrasing }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_BUDGET_MS)]),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") return null;
    const { completion, source, ms } = body as { completion?: unknown; source?: unknown; ms?: unknown };
    if (typeof completion !== "string" || !completion.trim() || (source !== "cloud" && source !== "cloudflare")) return null;
    return { completion, source, ms: typeof ms === "number" ? ms : 0 };
  } catch {
    return null;
  }
}

export async function askRanking(
  typed: string,
  lastMessage: string,
  candidates: readonly Candidate[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetcher("/api/typing/rank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typed, lastMessage, candidates: candidates.map((candidate) => candidate.completion.trim()) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RANK_BUDGET_MS + 100)]),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const index = body && typeof body === "object" ? (body as { index?: unknown }).index : null;
    return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < candidates.length ? index : null;
  } catch {
    return null;
  }
}
