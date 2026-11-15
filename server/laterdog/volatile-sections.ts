import { createHash } from "node:crypto";

export type VolatileSection = { id: string; label: string; text: string };

export type DeliveredSections = Readonly<Record<string, { label: string; digest: string }>>;

export type VolatileTurn = {
  systemVolatile?: string;
  systemVolatileSections?: readonly VolatileSection[];
  mentionTurn?: boolean;
};

const STANDING_MARKERS: Readonly<Record<string, readonly string[]>> = {
  recent: ["\n- "],
  memory: ["\n\nYour memory (MEMORY.md):\n", "\n\nYour topic notes ("],
};

export const STANDING_SUFFIX = ":standing";

export function standingSplit(id: string, text: string): { standing: string; rest: string } {
  const at = (STANDING_MARKERS[id] ?? [])
    .map((marker) => text.indexOf(marker))
    .filter((index) => index > 0)
    .reduce((first, index) => Math.min(first, index), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(at)) return { standing: "", rest: text };
  return { standing: text.slice(0, at), rest: text.slice(at) };
}

export function volatileSectionsOf(sections: readonly VolatileSection[]): VolatileSection[] {
  return sections.flatMap((section) => {
    const { standing, rest } = standingSplit(section.id, section.text);
    const parts: VolatileSection[] = [];
    if (standing.trim()) parts.push({ id: section.id + STANDING_SUFFIX, label: `${section.label}, standing part`, text: standing });
    if (rest.length > 0) parts.push({ id: section.id, label: section.label, text: standing.trim() ? rest : standing + rest });
    return parts;
  });
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function deliveredSections(sections: readonly VolatileSection[]): DeliveredSections {
  return Object.fromEntries(sections.map((section) => [section.id, { label: section.label, digest: digest(section.text) }]));
}

export function parseDeliveredSections(raw: unknown): DeliveredSections | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries: Array<[string, { label: string; digest: string }]> = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") return null;
    const { label, digest: fingerprint } = value as { label?: unknown; digest?: unknown };
    if (typeof label !== "string" || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
    entries.push([id, { label, digest: fingerprint }]);
  }
  return Object.fromEntries(entries);
}

export function sameDelivered(a: DeliveredSections | null | undefined, b: DeliveredSections | null | undefined): boolean {
  if (!a || !b) return false;
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => b[id]?.digest === a[id]!.digest && b[id]?.label === a[id]!.label);
}

export function matchingSections(volatile: string, sections: readonly VolatileSection[] | undefined): readonly VolatileSection[] | null {
  if (!sections) return null;
  if (new Set(sections.map((section) => section.id)).size !== sections.length) return null;
  if (sections.some((section) => !section.text.trim())) return null;
  return sections.map((section) => section.text).join("") === volatile ? sections : null;
}

export type SectionUpdate = { full: boolean; changed: readonly VolatileSection[]; cleared: readonly string[] };

export function sectionUpdate(
  sections: readonly VolatileSection[],
  previous: DeliveredSections | null,
  redeliver = false,
): SectionUpdate {
  const present = new Set(sections.map((section) => section.id));
  const cleared = previous ? Object.entries(previous).filter(([id]) => !present.has(id)).map(([, value]) => value.label) : [];
  if (!previous || redeliver) return { full: true, changed: sections, cleared };
  return { full: false, changed: sections.filter((section) => previous[section.id]?.digest !== digest(section.text)), cleared };
}

export const FULL_SECTIONS_HEADING =
  "Context from later.dog that changes over time, in labelled sections. This is all of it: it replaces every earlier copy, and anything an earlier copy said that is not repeated here no longer applies.";
export const CHANGED_SECTIONS_HEADING =
  "Context from later.dog that changed. Each section below replaces its earlier copy; sections not listed here still hold as last given.";
export const ALL_SECTIONS_CLEARED =
  "The later.dog context notes from earlier in this conversation have been cleared; the standing instructions still apply.";

const renderSection = (section: VolatileSection) => `[${section.label}]\n${section.text.trim()}`;
const renderCleared = (label: string) => `[${label}]\nNothing here any more.`;

export function sectionNoteBody(update: SectionUpdate, hadEarlierNotes = false): string {
  if (update.full) {
    if (update.changed.length) return [FULL_SECTIONS_HEADING, ...update.changed.map(renderSection)].join("\n\n");
    return update.cleared.length || hadEarlierNotes ? ALL_SECTIONS_CLEARED : "";
  }
  if (!update.changed.length && !update.cleared.length) return "";
  return [CHANGED_SECTIONS_HEADING, ...update.changed.map(renderSection), ...update.cleared.map(renderCleared)].join("\n\n");
}

export function claudeVolatileNote(volatile: string, seen: string | null, redeliver = false): string {
  if (seen === volatile && !redeliver) return "";
  const body = volatile.trim()
    ? `This part of your instructions lives here rather than in the system prompt, so it can change without rewriting the conversation. It replaces any earlier copy:\n\n${volatile.trim()}`
    : seen?.trim() ? "The notes that were in your instructions earlier in this session have been cleared." : "";
  return body ? `<system-reminder>\n${body}\n</system-reminder>` : "";
}

const SEEN_PREFIX = "\u0000later.dog volatile sections\u0000";

function seenSections(seen: string | null): DeliveredSections | null {
  if (!seen?.startsWith(SEEN_PREFIX)) return null;
  try {
    return parseDeliveredSections(JSON.parse(seen.slice(SEEN_PREFIX.length)));
  } catch {
    return null;
  }
}

export function claudeSeenVolatile(turn: VolatileTurn): string {
  const volatile = turn.systemVolatile ?? "";
  const sections = matchingSections(volatile, turn.systemVolatileSections);
  return sections ? SEEN_PREFIX + JSON.stringify(deliveredSections(sections)) : volatile;
}

export function claudeContextNote(turn: VolatileTurn, seen: string | null): { note: string; seen: string } {
  const volatile = turn.systemVolatile ?? "";
  const sections = matchingSections(volatile, turn.systemVolatileSections);
  const remember = claudeSeenVolatile(turn);
  if (!sections) return { note: claudeVolatileNote(volatile, seen, turn.mentionTurn), seen: remember };
  const previous = seenSections(seen);
  const body = sectionNoteBody(sectionUpdate(sections, previous, turn.mentionTurn), previous === null && Boolean(seen?.trim()));
  return { note: body ? `<system-reminder>\n${body}\n</system-reminder>` : "", seen: remember };
}
