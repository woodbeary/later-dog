
export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export class LiveTranscript {
  private input: TranscriptSegment[] = [];
  private output: Array<{ startMs: number; endMs: number }> = [];
  private cutoffMs = -1;

  addInput(text: string, startMs: number, endMs: number): void {
    if (!text) return;
    this.input.push({ text, startMs: Number.isFinite(startMs) ? startMs : 0, endMs: Number.isFinite(endMs) ? endMs : 0 });
    if (this.input.length > 2_000) this.input = this.input.filter((segment) => segment.startMs > this.cutoffMs);
  }

  addOutput(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    const last = this.output.at(-1);
    if (last && startMs <= last.endMs) last.endMs = Math.max(last.endMs, endMs);
    else this.output.push({ startMs, endMs });
    if (this.output.length > 500) this.output.splice(0, this.output.length - 500);
  }

  takeRequest(offsetMs: number, graceMs = 1_500): string {
    return this.takeRequestParts(offsetMs, graceMs).text;
  }

  takeRequestParts(offsetMs: number, graceMs = 1_500): { text: string; withoutEcho: string } {
    const until = offsetMs + graceMs;
    const taken = this.input.filter((segment) => segment.startMs > this.cutoffMs && segment.startMs <= until);
    if (!taken.length) return { text: "", withoutEcho: "" };
    this.cutoffMs = Math.max(this.cutoffMs, ...taken.map((segment) => segment.startMs));
    return {
      text: joinFragments(taken.map((segment) => segment.text)),
      withoutEcho: joinFragments(taken.filter((segment) => !this.echoed(segment)).map((segment) => segment.text)),
    };
  }

  pending(options: { skipEcho?: boolean } = {}): string {
    return joinFragments(this.input
      .filter((segment) => segment.startMs > this.cutoffMs && !(options.skipEcho && this.echoed(segment)))
      .map((segment) => segment.text));
  }

  private echoed(segment: TranscriptSegment): boolean {
    return this.output.some((span) => segment.startMs < span.endMs && segment.endMs > span.startMs);
  }

  consumeAll(): void {
    for (const segment of this.input) this.cutoffMs = Math.max(this.cutoffMs, segment.startMs);
  }
}

export function joinFragments(fragments: string[]): string {
  return fragments.join("").replace(/\s+/g, " ").trim();
}

const APPEND_BYTE_LIMIT = 500;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

function bytePrefix(text: string, budget: number): string {
  return new TextDecoder().decode(encoder.encode(text).subarray(0, budget), { stream: true });
}
const MAX_SPOKEN_CHUNKS = 3;
export const FULL_ANSWER_IN_CHAT = "The full answer is in the chat.";

export function commentaryChunks(utterances: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  let truncated = false;
  for (const raw of utterances) {
    const utterance = raw.replace(/\s+/g, " ").trim();
    if (!utterance) continue;
    const pieces = bytes(utterance) > APPEND_BYTE_LIMIT ? splitLong(utterance) : [utterance];
    for (const piece of pieces) {
      if (current && bytes(current) + 1 + bytes(piece) > APPEND_BYTE_LIMIT) {
        chunks.push(current);
        current = "";
      }
      if (chunks.length >= MAX_SPOKEN_CHUNKS) {
        truncated = true;
        break;
      }
      current = current ? `${current} ${piece}` : piece;
    }
    if (truncated) break;
  }
  if (current && chunks.length < MAX_SPOKEN_CHUNKS) chunks.push(current);
  else if (current) truncated = true;
  if (truncated && chunks.length) {
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = bytes(last) + 1 + bytes(FULL_ANSWER_IN_CHAT) <= APPEND_BYTE_LIMIT
      ? `${last} ${FULL_ANSWER_IN_CHAT}`
      : `${bytePrefix(last, APPEND_BYTE_LIMIT - bytes(FULL_ANSWER_IN_CHAT) - 1).replace(/\s+\S*$/, "")} ${FULL_ANSWER_IN_CHAT}`;
  }
  return chunks;
}

function splitLong(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (bytes(rest) > APPEND_BYTE_LIMIT) {
    const window = bytePrefix(rest, APPEND_BYTE_LIMIT);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const space = window.lastIndexOf(" ");
    const cut = sentence > window.length / 2 ? sentence + 1 : space > 0 ? space : window.length;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function clampAppend(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  return bytes(text) <= APPEND_BYTE_LIMIT ? text : `${bytePrefix(text, APPEND_BYTE_LIMIT - bytes("…")).replace(/\s+\S*$/, "")}…`;
}

export const LIVE_VOICE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "marin", label: "Marin (default)" },
  { id: "cedar", label: "Cedar" },
  { id: "alloy", label: "Alloy" },
  { id: "ash", label: "Ash" },
  { id: "ballad", label: "Ballad" },
  { id: "coral", label: "Coral" },
  { id: "echo", label: "Echo" },
  { id: "sage", label: "Sage" },
  { id: "shimmer", label: "Shimmer" },
  { id: "verse", label: "Verse" },
  { id: "gleam", label: "Gleam — North American, feminine" },
  { id: "meridian", label: "Meridian — North American, masculine" },
  { id: "quartz", label: "Quartz — Australian, feminine" },
  { id: "ripple", label: "Ripple — Australian, masculine" },
  { id: "vesper", label: "Vesper — British, masculine" },
  { id: "willow", label: "Willow — Irish, feminine" },
  { id: "stone", label: "Stone — Irish, masculine" },
  { id: "delta", label: "Delta — Southern U.S., feminine" },
  { id: "cinder", label: "Cinder — Southern U.S., masculine" },
  { id: "beacon", label: "Beacon — Filipino, masculine" },
  { id: "bossa", label: "Bossa — Brazilian Portuguese, feminine" },
  { id: "tempo", label: "Tempo — Brazilian Portuguese, masculine" },
];
