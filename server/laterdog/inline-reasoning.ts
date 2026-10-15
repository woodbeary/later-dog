export type ReplyStream = "assistant_text" | "reasoning_text";

export interface InlineReasoning {
  answeredBy(model: unknown): void;
  reasoningApart(): void;
  content(delta: string): void;
  end(): void;
}

type Phase = "undecided" | "tagged" | "untagged" | "closed" | "answer";

const OPEN = "<think>";
const CLOSE = "</think>";
const REASONS_IN_CONTENT = /kimi|deepseek-r1|qwq/i;
const ANSWER_START = /^[`{[<|#>~]/;

export const reasonsInContent = (model: unknown): boolean => typeof model === "string" && REASONS_IN_CONTENT.test(model);

function safeEnd(text: string): number {
  for (let length = Math.min(CLOSE.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(CLOSE.slice(0, length))) return text.length - length;
  }
  return text.length;
}

export function inlineReasoning(expected: boolean, emit: (text: string, stream: ReplyStream) => void): InlineReasoning {
  let expecting = expected;
  let apart = false;
  let phase: Phase | null = null;
  let pending = "";
  let thought = "";
  const say = (text: string, stream: ReplyStream) => {
    if (text) emit(text, stream);
  };
  const think = (text: string) => {
    thought += text;
    say(text, "reasoning_text");
  };
  const advance = () => {
    for (;;) {
      if (phase === "answer") {
        say(pending, "assistant_text");
        pending = "";
        return;
      }
      if (phase === "closed") {
        pending = pending.trimStart();
        if (!pending) return;
        phase = "answer";
        continue;
      }
      if (phase === "undecided") {
        const lead = pending.trimStart();
        if (lead.startsWith(OPEN)) {
          pending = lead.slice(OPEN.length);
          phase = "tagged";
          continue;
        }
        if (!lead.startsWith(CLOSE)) {
          if (!lead || OPEN.startsWith(lead) || CLOSE.startsWith(lead)) return;
          if (ANSWER_START.test(lead)) {
            phase = "answer";
            continue;
          }
        }
        pending = lead;
        phase = "untagged";
        continue;
      }
      const close = pending.indexOf(CLOSE);
      if (close >= 0) {
        think(pending.slice(0, close));
        pending = pending.slice(close + CLOSE.length);
        thought = "";
        phase = "closed";
        continue;
      }
      const cut = safeEnd(pending);
      think(pending.slice(0, cut));
      pending = pending.slice(cut);
      return;
    }
  };
  return {
    answeredBy(model) {
      if (reasonsInContent(model)) expecting = true;
    },
    reasoningApart() {
      apart = true;
      if (phase !== "undecided") return;
      phase = "answer";
      advance();
    },
    content(delta) {
      if (!delta) return;
      phase ??= expecting && !apart ? "undecided" : "answer";
      pending += delta;
      advance();
    },
    end() {
      if (phase === "untagged") say(thought + pending, "assistant_text");
      else if (phase === "tagged") say(pending, "reasoning_text");
      else if (phase === "undecided" || phase === "answer") say(pending, "assistant_text");
      pending = "";
      thought = "";
      phase = "answer";
    },
  };
}

export function replyWithoutReasoning(content: string, expected: boolean): string {
  let reply = "";
  const split = inlineReasoning(expected, (text, stream) => {
    if (stream === "assistant_text") reply += text;
  });
  split.content(content);
  split.end();
  return reply;
}
