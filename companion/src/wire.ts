
const WITHHELD_KEYS = new Set(["resumeCursors", "sshAlias"]);

export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrub) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (WITHHELD_KEYS.has(key)) continue;
      out[key] = scrub(inner);
    }
    return out as T;
  }
  return value;
}

export const isJson = (contentType: string | undefined): boolean => {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
};

export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export function createSseScrubber(): (chunk: string) => string {
  let pending = "";
  return (chunk: string): string => {
    pending += chunk;
    let out = "";
    for (;;) {
      const boundary = nextBoundary(pending);
      if (!boundary) break;
      const event = pending.slice(0, boundary.index);
      if (Buffer.byteLength(event) > MAX_SSE_EVENT_BYTES) {
        throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
      }
      pending = pending.slice(boundary.index + boundary.terminator.length);
      out += scrubEvent(event) + boundary.terminator;
    }
    if (Buffer.byteLength(pending) > MAX_SSE_EVENT_BYTES) {
      throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes without a terminator`);
    }
    return out;
  };
}

function nextBoundary(text: string): { index: number; terminator: string } | null {
  let best: { index: number; terminator: string } | null = null;
  for (const terminator of ["\n\n", "\r\n\r\n", "\r\r"]) {
    const index = text.indexOf(terminator);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && terminator.length > best.terminator.length)) {
      best = { index, terminator };
    }
  }
  return best;
}

function scrubEvent(event: string): string {
  const eol = event.includes("\r\n") ? "\r\n" : event.includes("\r") ? "\r" : "\n";
  return event
    .split(/\r\n|\r|\n/)
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const raw = line.slice(5).trimStart();
      if (!raw) return line;
      try {
        return `data: ${JSON.stringify(scrub(JSON.parse(raw)))}`;
      } catch {
        return line;
      }
    })
    .join(eol);
}
