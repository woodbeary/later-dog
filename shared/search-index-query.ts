export type SearchMode = "all" | "any";

export interface RecallRange {
  since?: number;
  until?: number;
}

const STOP_WORDS = new Set(
  "a an and are as at be by did do for from had has have how i in is it its of on or that the this to was we were what when where which who why with you your".split(" "),
);

const RECALL_FILLER = new Set(
  "about again also any anything can could does don't know me my please remember remind should tell there they us would hi hello hey thanks thank ok okay yes yeah no i'm im i've i'll i'd you're quick just".split(" "),
);

export function recallTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.split(/\s+|(?<=\p{L})[/,;:.—–-]+(?=\p{L})/u)) {
    const token = raw.replace(/"/g, "").replace(/^[\s.,;:!?()[\]{}'`“”‘’]+|[\s.,;:!?()[\]{}'`“”‘’]+$/g, "").toLowerCase();
    if (token.length < 2 && !/\d/.test(token)) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    if (STOP_WORDS.has(token) || RECALL_FILLER.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 16);
}

export function recallMatchTerm(term: string): string | null {
  if (!/^[\p{L}\p{N}]+$/u.test(term)) return null;
  if (!/^\p{L}{4,}$/u.test(term)) return `"${term}"`;
  const stem = term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
  return `"${stem}"*`;
}

export function ftsQuery(query: string, mode: SearchMode = "all"): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(/"/g, "").trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  const content = tokens.filter((token) => !STOP_WORDS.has(token.toLowerCase()));
  if (mode === "any") {
    const terms = recallTerms(query).map(recallMatchTerm).filter(Boolean);
    return terms.length ? terms.join(" OR ") : null;
  }
  return (content.length ? content : tokens).map((token) => `"${token}"`).join(" ");
}

export function rangeClause(range: RecallRange | undefined, column: string): { sql: string; params: number[] } {
  const parts: string[] = [];
  const params: number[] = [];
  if (range?.since !== undefined) {
    parts.push(`${column} >= ?`);
    params.push(range.since);
  }
  if (range?.until !== undefined) {
    parts.push(`${column} <= ?`);
    params.push(range.until);
  }
  return { sql: parts.map((part) => ` AND ${part}`).join(""), params };
}

export interface SubstringSnippet {
  snippet: string;
  matchStart: number;
  matchLength: number;
}

export function substringSnippet(haystack: string, needle: string): SubstringSnippet {
  const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
  const start = Math.max(0, hitAt - 60);
  const end = Math.min(haystack.length, hitAt + needle.length + 90);
  const head = start > 0 ? "…" : "";
  const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  const snippet = head + body + (end < haystack.length ? "…" : "");
  const folded = needle.replace(/\s+/g, " ");
  const matchStart = snippet.toLowerCase().indexOf(folded);
  return { snippet, matchStart: matchStart < 0 ? head.length : matchStart, matchLength: matchStart < 0 ? 0 : folded.length };
}

export function textSum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}
