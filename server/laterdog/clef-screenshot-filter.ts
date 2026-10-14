import { redactSecretsInText } from "../../shared/redact.ts";
import type { Decider } from "../decider/index.ts";
import type { YesNoQuestion } from "../decider/types.ts";
import type { Breaker } from "./clef-breaker.ts";
import { createBoundedMap } from "./clef-bounded.ts";
import { fastDecide } from "./clef-fast-decide.ts";
import type { ImageShrinker } from "./clef-images.ts";
import type { ClefLogRow } from "./clef-log.ts";

export const SCREENSHOT_FILTER_BUDGET_MS = 1_500;
export const WORTH_SHOWING_MIN_PROBABILITY = 0.6;
export const SECRET_MAX_PROBABILITY = 0.3;

const TASK_MAX = 800;
const REPLY_MAX = 1_200;

export const WORTH_QUESTION: YesNoQuestion = {
  type: "yesno",
  instructions: "Is the last image worth showing the person right now? Yes for a finished result, something that needs their attention, or a clear change from the earlier image. No for a blank, loading, unchanged or in-between screen.",
};

export const SECRET_QUESTION: YesNoQuestion = {
  type: "yesno",
  instructions: "Does the last image show a password, an API key, a token, a recovery code, a card number or any other secret?",
};

export interface Frame {
  png: string;
  mime: string;
}

export type FilterOutcome =
  | { post: true; reason: "worth_showing" | "decider_unavailable" | "off" }
  | { post: false; reason: "not_worth_showing" | "secret_likely" };

export interface ScreenshotFilterDeps {
  decider: Pick<Decider, "ask"> | undefined;
  enabled(): boolean;
  record(row: ClefLogRow): void;
  shrink?: ImageShrinker;
  budgetMs?: number;
  breaker?: Breaker;
  threadAlive?(threadId: string): boolean;
}

const clip = (text: string, max: number) => {
  const flat = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function createScreenshotFilter(deps: ScreenshotFilterDeps) {
  const lastPosted = createBoundedMap<Frame>({ max: 30, ttlMs: 60 * 60_000 });

  return {
    active: () => deps.enabled(),
    async shouldPost(input: { threadId: string; frame: Frame; task: string; reply: string }): Promise<FilterOutcome> {
      if (!deps.enabled()) return { post: true, reason: "off" };
      if (deps.threadAlive) lastPosted.sweep(deps.threadAlive);
      const before = lastPosted.get(input.threadId);
      const decided = await fastDecide(
        deps.decider,
        "screenshotFilter",
        { task: clip(input.task, TASK_MAX), last_reply: clip(input.reply, REPLY_MAX), earlier_image_shown: Boolean(before) },
        { worth: WORTH_QUESTION, secret: SECRET_QUESTION },
        {
          budgetMs: deps.budgetMs ?? SCREENSHOT_FILTER_BUDGET_MS,
          images: [...(before ? [{ data: before.png, format: before.mime }] : []), { data: input.frame.png, format: input.frame.mime }],
          shrink: deps.shrink,
          breaker: deps.breaker,
        },
      );
      if (!decided.decided) {
        deps.record({ kind: "screenshotFilter", threadId: input.threadId, action: "posted", reason: `decider_${decided.reason}` });
        lastPosted.set(input.threadId, input.frame);
        return { post: true, reason: "decider_unavailable" };
      }
      const worth = decided.answers.worth.p;
      const secret = decided.answers.secret.p;
      const row = { kind: "screenshotFilter" as const, threadId: input.threadId, worth, secret, latencyMs: decided.latencyMs };
      if (secret > SECRET_MAX_PROBABILITY) {
        deps.record({ ...row, action: "withheld", reason: "secret_likely" });
        return { post: false, reason: "secret_likely" };
      }
      if (worth < WORTH_SHOWING_MIN_PROBABILITY) {
        deps.record({ ...row, action: "withheld", reason: "not_worth_showing" });
        return { post: false, reason: "not_worth_showing" };
      }
      lastPosted.set(input.threadId, input.frame);
      deps.record({ ...row, action: "posted", reason: "worth_showing" });
      return { post: true, reason: "worth_showing" };
    },
    forget(threadId: string): void {
      lastPosted.delete(threadId);
    },
  };
}

export type ScreenshotFilter = ReturnType<typeof createScreenshotFilter>;
