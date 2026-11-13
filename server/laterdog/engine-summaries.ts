import { readFileSync } from "node:fs";
import { redactSecretsInText } from "../../shared/redact.ts";
import { writeFileAtomic } from "../atomic.ts";
import { boundedContextText, MAX_SUMMARY_BYTES } from "../context-rebuild.ts";
import type { EngineSummary } from "./rebuild-summary.ts";

export const KEPT_CHATS = 500;

export interface EngineSummaries {
  read(threadId: string): EngineSummary | undefined;
  remember(threadId: string, summary: { text: string; throughId: string }): void;
}

export function fileEngineSummaries(path: string, now: () => number = Date.now): EngineSummaries {
  let cache: Record<string, EngineSummary> | null = null;
  const load = (): Record<string, EngineSummary> => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, EngineSummary> : {};
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    read: (threadId) => {
      const entry = load()[threadId];
      return entry && typeof entry.text === "string" && typeof entry.throughId === "string" ? entry : undefined;
    },
    remember: (threadId, summary) => {
      const text = boundedContextText(redactSecretsInText(summary.text.trim()), MAX_SUMMARY_BYTES);
      if (!text || !summary.throughId) return;
      const all = { ...load(), [threadId]: { text, throughId: summary.throughId, at: now() } };
      const kept = Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, KEPT_CHATS);
      cache = Object.fromEntries(kept);
      writeFileAtomic(path, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    },
  };
}
