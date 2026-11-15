import type { VolatileSection } from "./volatile-sections.ts";

const KEPT_THROUGH_COMPACTION: ReadonlySet<string> = new Set(["user-profile", "connected"]);

export const CARRY_MAX_BYTES = 24_000;

const rendered = (section: VolatileSection) => `[${section.label}]\n${section.text.trim()}`;

const sizeOf = (section: VolatileSection) => Buffer.byteLength(rendered(section), "utf8");

function cutToBytes(text: string, max: number): string {
  if (max <= 0) return "";
  return Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "").trimEnd();
}

export function carriedSections(sections: readonly VolatileSection[]): VolatileSection[] {
  const kept = sections.filter((section) => KEPT_THROUGH_COMPACTION.has(section.id) && section.text.trim());
  const fitted = new Map<VolatileSection, VolatileSection>();
  let room = CARRY_MAX_BYTES;
  for (const section of [...kept].sort((a, b) => sizeOf(a) - sizeOf(b))) {
    const whole = sizeOf(section);
    if (whole <= room) {
      fitted.set(section, section);
      room -= whole;
      continue;
    }
    const text = cutToBytes(section.text.trim(), room - Buffer.byteLength(`[${section.label}]\n`, "utf8"));
    if (!text) continue;
    const cut = { ...section, text };
    fitted.set(section, cut);
    room -= sizeOf(cut);
  }
  return kept.flatMap((section) => fitted.get(section) ?? []);
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
