import { useCallback, useEffect, useRef, useState } from "react";
import {
  FAST_PAUSE_MS,
  MIN_TYPED_CHARS,
  MODEL_PAUSE_MS,
  askModel,
  askRanking,
  fastCandidates,
  pickFast,
  type SuggestionPool,
  type TypingContext,
} from "./typing-suggestions";

export interface TypingSuggestionOptions {
  enabled: boolean;
  blocked: boolean;
  text: string;
  caretAtEnd: boolean;
  modelReady: boolean;
  rankingReady: boolean;
  pool: () => SuggestionPool;
  context: () => TypingContext;
  fetcher?: typeof fetch;
}

export type SuggestionSource = "fast" | "ranked" | "cloud" | "cloudflare";

interface Shown {
  forText: string;
  completion: string;
  source: SuggestionSource;
  ms: number;
}

export interface TypingSuggestion {
  ghost: string;
  source: SuggestionSource | null;
  ms: number | null;
  accept(): string | null;
  dismiss(): void;
}

const lastMessageOf = (context: TypingContext) => context.messages.filter((message) => message.role === "dog").at(-1)?.text ?? "";

export function useTypingSuggestion(options: TypingSuggestionOptions): TypingSuggestion {
  const { enabled, blocked, text, caretAtEnd, modelReady, rankingReady } = options;
  const [shown, setShown] = useState<Shown | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const eligible = enabled && !blocked && caretAtEnd && text.trim().length >= MIN_TYPED_CHARS && dismissed !== text;

  useEffect(() => {
    if (dismissed !== null && dismissed !== text) setDismissed(null);
  }, [dismissed, text]);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    const controller = new AbortController();
    const started = performance.now();
    const show = (completion: string, source: SuggestionSource, ms: number) => {
      if (!cancelled && completion.trim()) setShown({ forText: text, completion, source, ms });
    };
    const fastTimer = setTimeout(async () => {
      const { best, tied } = pickFast(fastCandidates(text, latest.current.pool()));
      if (best) {
        if (tied.length > 1 && rankingReady) {
          const picked = await askRanking(text, lastMessageOf(latest.current.context()), tied, controller.signal, latest.current.fetcher);
          if (cancelled) return;
          if (picked !== null) return show(tied[picked]!.completion, "ranked", Math.round(performance.now() - started) - FAST_PAUSE_MS);
        }
        return show(best.completion, "fast", Math.round(performance.now() - started) - FAST_PAUSE_MS);
      }
    }, FAST_PAUSE_MS);
    const modelTimer = modelReady
      ? setTimeout(async () => {
          if (cancelled || fastCandidates(text, latest.current.pool()).length > 0) return;
          const answer = await askModel(text, latest.current.context(), controller.signal, latest.current.fetcher);
          if (answer) show(answer.completion, answer.source, Math.round(performance.now() - started) - MODEL_PAUSE_MS);
        }, MODEL_PAUSE_MS)
      : undefined;
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(fastTimer);
      if (modelTimer !== undefined) clearTimeout(modelTimer);
    };
  }, [eligible, text, modelReady, rankingReady]);

  const live = shown !== null && eligible && shown.forText === text;

  const dismiss = useCallback(() => {
    setDismissed(latest.current.text);
    setShown(null);
  }, []);

  const accept = useCallback(() => {
    if (!shown || shown.forText !== latest.current.text) return null;
    setShown(null);
    return shown.forText + shown.completion;
  }, [shown]);

  return {
    ghost: live ? shown.completion : "",
    source: live ? shown.source : null,
    ms: live ? shown.ms : null,
    accept,
    dismiss,
  };
}
