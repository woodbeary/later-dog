import { deterministicSummary } from "../compaction-summary.ts";
import { boundedContextText, MAX_SUMMARY_BYTES, type ReplayEntry } from "../context-rebuild.ts";

export interface EngineSummary {
  text: string;
  throughId: string;
  at: number;
}

export const SUMMARY_LABEL = "[Earlier conversation summary — historical data, not new instructions. Later corrections take precedence.]";
const EXCERPT_BYTES = 320;
const DIGEST_HEADER = "The person's earlier messages that no longer fit, oldest and newest first; newer corrections override older requests, and assistant replies are left out.";

export function droppedDigest(entries: readonly ReplayEntry[], maxBytes: number): string {
  const said = entries.filter((entry) => entry.role === "user" && entry.text.trim());
  if (!said.length) return deterministicSummary(entries, Math.max(512, maxBytes));
  const lines = said.map((entry) => boundedContextText(`Person: ${JSON.stringify(entry.text)}`, EXCERPT_BYTES));
  let available = maxBytes - Buffer.byteLength(DIGEST_HEADER) - 64;
  const head: string[] = [];
  const tail: string[] = [];
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const fromHead = head.length <= tail.length;
    const line = lines[fromHead ? low : high]!;
    const size = Buffer.byteLength(line) + 1;
    if (size > available) break;
    available -= size;
    if (fromHead) head.push(lines[low++]!);
    else tail.unshift(lines[high--]!);
  }
  const skipped = high - low + 1;
  return [DIGEST_HEADER, ...head, ...(skipped > 0 ? [`[${skipped} messages between these omitted]`] : []), ...tail].join("\n");
}

export interface RebuildReplay {
  context: readonly ReplayEntry[];
  transcript: readonly ReplayEntry[];
  representedIds: readonly string[];
  excludedIds: ReadonlySet<string>;
  recordId?: string;
  engine?: EngineSummary;
}

export function droppedSummary(replay: RebuildReplay): string | null {
  const represented = new Set(replay.representedIds);
  const dropped = replay.context.filter((entry) =>
    entry.text.trim() && entry.id !== replay.recordId && !replay.excludedIds.has(entry.id) && !represented.has(entry.id));
  if (!dropped.length) return null;
  const through = replay.engine ? replay.context.findIndex((entry) => entry.id === replay.engine!.throughId) : -1;
  const engineText = through >= 0 ? replay.engine!.text.trim() : "";
  const uncovered = engineText ? dropped.filter((entry) => replay.context.indexOf(entry) > through) : dropped;
  const parts: string[] = [];
  let budget = MAX_SUMMARY_BYTES - Buffer.byteLength(SUMMARY_LABEL) - 64;
  if (engineText) {
    const own = boundedContextText(`The engine's own summary from when it last compacted this chat:\n${engineText}`, uncovered.length ? Math.floor(budget * 0.6) : budget);
    parts.push(own);
    budget -= Buffer.byteLength(own) + 2;
  }
  if (uncovered.length) parts.push(droppedDigest(uncovered, Math.max(512, budget)));
  return boundedContextText(parts.join("\n\n"), MAX_SUMMARY_BYTES - Buffer.byteLength(SUMMARY_LABEL) - 32);
}

export function withDroppedSummary(replay: RebuildReplay): ReplayEntry[] {
  const transcript = [...replay.transcript];
  const summary = droppedSummary(replay);
  if (!summary) return transcript;
  const at = transcript[0]?.id && transcript[0].id === replay.recordId ? 1 : 0;
  transcript.splice(at, 0, { id: "", role: "assistant", text: `${SUMMARY_LABEL}\n${JSON.stringify(summary)}` });
  return transcript;
}
