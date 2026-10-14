import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { isOpenSecureForm, type SecureFormCardData } from "../../shared/secure-form";
import { typingSuggestionsEnabled, type FeatureFlagConfig } from "./feature-flags";
import {
  buildTypingContext,
  learnSent,
  loadPhrases,
  suggestionsBlocked,
  type ChatLine,
  type PhraseBook,
} from "./typing-suggestions";
import { useTypingSuggestion, type SuggestionSource } from "./use-typing-suggestion";

export interface TypingStatus {
  enabled: boolean;
  included: boolean;
  cloudflare: { configured: boolean };
  ranking: boolean;
}

export interface ComposerSuggestionOptions {
  config: (FeatureFlagConfig & { typing?: TypingStatus }) | null | undefined;
  text: string;
  caret: number;
  field: Element | null;
  lines: ReadonlyArray<ChatLine & { secureForm?: SecureFormCardData }>;
  dog: string;
  dogNames: readonly string[];
  commands: readonly string[];
  recording: boolean;
  listening: boolean;
  locked: boolean;
  approval: boolean;
  picker: boolean;
  edit(next: string): void;
  moveCaret(at: number): void;
}

export interface ComposerSuggestion {
  ghost: string;
  source: SuggestionSource | null;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  sent(text: string): void;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);
const TEXT_KEYS = new Set(["Backspace", "Delete", "Enter"]);
const RECENT_FOR_SECURE_FORMS = 20;

export function useComposerSuggestion(options: ComposerSuggestionOptions): ComposerSuggestion {
  const { config, text, caret } = options;
  const [composing, setComposing] = useState(false);
  const book = useRef<PhraseBook | null>(null);
  const phrases = () => (book.current ??= loadPhrases());
  const enabled = typingSuggestionsEnabled(config);
  const typing = config?.typing;
  const secureFormOpen = options.lines.slice(-RECENT_FOR_SECURE_FORMS).some((line) => line.secureForm !== undefined && isOpenSecureForm(line.secureForm.status));
  const blocked = suggestionsBlocked({
    recording: options.recording,
    listening: options.listening,
    locked: options.locked,
    approval: options.approval,
    secureFormOpen,
    picker: options.picker,
    composing,
    field: options.field,
  });
  const suggestion = useTypingSuggestion({
    enabled,
    blocked,
    text,
    caretAtEnd: caret === text.length,
    modelReady: Boolean(typing?.included || typing?.cloudflare.configured),
    rankingReady: Boolean(typing?.ranking),
    pool: () => ({ phrases: phrases(), dogNames: options.dogNames, commands: options.commands }),
    context: () => buildTypingContext(options.lines, options.dog, phrases()),
  });
  const { ghost, accept, dismiss } = suggestion;

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && ghost) {
      const next = accept();
      if (next !== null) {
        event.preventDefault();
        options.edit(next);
        options.moveCaret(next.length);
        return true;
      }
    }
    if (event.key === "Escape" && ghost) {
      event.preventDefault();
      dismiss();
      return true;
    }
    if (event.key.length > 1 && !TEXT_KEYS.has(event.key) && !MODIFIER_KEYS.has(event.key)) dismiss();
    return false;
  }, [ghost, accept, dismiss, options]);

  const sent = useCallback((message: string) => {
    if (!enabled) return;
    learnSent(message);
    book.current = null;
  }, [enabled]);

  return {
    ghost,
    source: suggestion.source,
    onKeyDown,
    onCompositionStart: () => {
      dismiss();
      setComposing(true);
    },
    onCompositionEnd: () => setComposing(false),
    sent,
  };
}
