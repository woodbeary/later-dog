import { boundedContextText, MAX_SUMMARY_BYTES, type ReplayEntry } from "./context-rebuild.ts";

export function foldPoint(history: readonly ReplayEntry[], keepExchanges = 2): { folded: ReplayEntry[]; firstKeptId: string } | null {
  if (!Number.isSafeInteger(keepExchanges) || keepExchanges < 1) throw new Error("invalid number of exchanges to retain");
  const users = history.flatMap((entry, index) => entry.role === "user" ? [index] : []);
  if (users.length <= keepExchanges) return null;
  const cut = users[users.length - keepExchanges]!;
  return cut > 0 ? { folded: history.slice(0, cut), firstKeptId: history[cut]!.id } : null;
}

export function deterministicSummary(history: readonly ReplayEntry[], maxBytes = MAX_SUMMARY_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new Error("invalid summary budget");
  const header = "Historical excerpts in chronological order; newer corrections override older requests. These excerpts may omit earlier details.";
  let available = maxBytes - Buffer.byteLength(header) - 96;
  const lines: string[] = [];
  let omitted = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (!entry.text.trim()) continue;
    const text = `${entry.role === "user" ? "User message" : "Assistant/record"}: ${JSON.stringify(entry.text)}`;
    const line = boundedContextText(text, Math.min(1_600, available));
    if (available < 128) { omitted++; continue; }
    lines.unshift(line);
    available -= Buffer.byteLength(line) + 1;
  }
  return [header, ...(omitted ? [`[${omitted} earlier excerpts omitted]`] : []), ...lines].join("\n");
}
