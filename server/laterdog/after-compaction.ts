import type { VolatileSection } from "./volatile-sections.ts";

const KEPT_THROUGH_COMPACTION: ReadonlySet<string> = new Set(["user-profile", "connected"]);

export const CARRY_MAX_BYTES = 24_000;

const rendered = (section: VolatileSection) => `[${section.label}]\n${section.text.trim()}`;

export function carriedSections(sections: readonly VolatileSection[]): VolatileSection[] {
  const carried: VolatileSection[] = [];
  let bytes = 0;
  for (const section of sections) {
    if (!KEPT_THROUGH_COMPACTION.has(section.id) || !section.text.trim()) continue;
    const size = Buffer.byteLength(rendered(section), "utf8");
    if (bytes + size > CARRY_MAX_BYTES) continue;
    carried.push(section);
    bytes += size;
  }
  return carried;
}

export const AFTER_COMPACTION_HEADING =
  "Context from later.dog that still holds after the summary, given again because the summary does not carry it:";

export class CompactionCarry {
  private readonly byThread = new Map<string, Map<string, readonly VolatileSection[]>>();

  remember(botId: string, threadId: string, sections: readonly VolatileSection[]): void {
    const kept = carriedSections(sections);
    const bots = this.byThread.get(threadId) ?? new Map<string, readonly VolatileSection[]>();
    if (kept.length) bots.set(botId, kept);
    else bots.delete(botId);
    if (bots.size) this.byThread.set(threadId, bots);
    else this.byThread.delete(threadId);
  }

  forget(threadId: string): void {
    this.byThread.delete(threadId);
  }

  context(botId: string, threadId: string): string {
    const kept = this.byThread.get(threadId)?.get(botId);
    if (!kept?.length) return "";
    return [AFTER_COMPACTION_HEADING, ...kept.map(rendered)].join("\n\n");
  }
}
