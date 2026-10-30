export type DraftVia = "email" | "text" | "x" | "message";

export interface DraftCard {
  kind: "draft";
  via: DraftVia;
  to: string[];
  cc: string[];
  subject?: string;
  id?: string;
  body: string;
}

export interface WordChange {
  text: string;
  change: "same" | "added" | "removed";
}

const VIAS: readonly DraftVia[] = ["email", "text", "x", "message"];
const MAX_BODY = 20_000;
const MAX_DIFF_WORDS = 2_000;
const DRAFT_BLOCK = /```draft[^\S\n]*\n([\s\S]*?)```/g;

function line(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, max) : undefined;
}

function people(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : [];
  return list.map((entry) => line(entry, 200)).filter((entry): entry is string => Boolean(entry)).slice(0, 20);
}

function via(value: unknown): DraftVia {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (name === "post" || name === "tweet" || name === "twitter") return "x";
  if (name === "sms" || name === "imessage") return "text";
  return (VIAS as readonly string[]).includes(name) ? name as DraftVia : "message";
}

function header(first: string): Record<string, unknown> | null {
  const trimmed = first.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function draftCard(lang: string, source: string): DraftCard | null {
  if (lang.trim().toLowerCase() !== "draft") return null;
  const [first = "", ...rest] = source.split("\n");
  const data = header(first);
  const body = (data ? rest.join("\n") : source).trim().slice(0, MAX_BODY);
  if (!body) return null;
  const subject = line(data?.subject);
  const id = line(data?.id, 80);
  return { kind: "draft", via: via(data?.via), to: people(data?.to), cc: people(data?.cc), ...(subject ? { subject } : {}), ...(id ? { id } : {}), body };
}

export function draftsIn(text: string): DraftCard[] {
  return [...text.matchAll(DRAFT_BLOCK)].map((match) => draftCard("draft", match[1] ?? "")).filter((card): card is DraftCard => card !== null);
}

export function earlierVersion(earlierTexts: readonly string[], card: DraftCard): DraftCard | null {
  if (!card.id) return null;
  for (let index = earlierTexts.length - 1; index >= 0; index--) {
    const found = draftsIn(earlierTexts[index]!).filter((draft) => draft.id === card.id).at(-1);
    if (found) return found.body === card.body ? null : found;
  }
  return null;
}

export function wordChanges(before: string, after: string): WordChange[] | null {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) return null;
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const changes: WordChange[] = [];
  const push = (text: string, change: WordChange["change"]) => {
    const last = changes.at(-1);
    if (last?.change === change) last.text += text;
    else changes.push({ text, change });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(a[i]!, "same"); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { push(a[i]!, "removed"); i++; }
    else { push(b[j]!, "added"); j++; }
  }
  while (i < a.length) push(a[i++]!, "removed");
  while (j < b.length) push(b[j++]!, "added");
  return changes;
}

export function draftBlock(card: DraftCard, body: string): string {
  const head = {
    via: card.via,
    ...(card.to.length ? { to: card.to } : {}),
    ...(card.cc.length ? { cc: card.cc } : {}),
    ...(card.subject ? { subject: card.subject } : {}),
    ...(card.id ? { id: card.id } : {}),
  };
  return `\`\`\`draft\n${JSON.stringify(head)}\n${body.trim()}\n\`\`\``;
}
