import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { AppConfig } from "../config.ts";
import { autoVerdict } from "../auto-approve.ts";
import type { RequestOutcome } from "../contracts.ts";
import { deciderImagesReady, deciderReady, type Decider } from "../decider/index.ts";
import { createAutoReview, type ReviewContext } from "./clef-auto-review.ts";
import { createBreaker } from "./clef-breaker.ts";
import { autoReviewRules } from "./clef-config.ts";
import { sipsShrinker } from "./clef-image-shrink.ts";
import { appendClefLog } from "./clef-log.ts";
import { createScreenCheck } from "./clef-screen-check.ts";
import { createScreenshotFilter, type Frame } from "./clef-screenshot-filter.ts";
import { createTurnEndWatcher, type TurnEndInput } from "./clef-turn-end.ts";

type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;

const ASKS_A_PERSON = /^(mcp__[^_]+__)?(askuserquestion|ask_user)$/i;

export interface ClefAsker {
  id: string;
  name: string;
  approvalMode: ApprovalMode;
  commandAllowed: boolean;
  guestDriven: boolean;
  cwd?: string;
  projectRoot?: string;
}

export interface ClefDeps {
  decider: Pick<Decider, "ask">;
  config(): AppConfig;
  deliver(event: RuntimeEvent): void;
  asker(event: Opened): ClefAsker | null;
  respond(event: Opened, behavior: "allow" | "deny", message?: string): Promise<RequestOutcome | "failed">;
  note(threadId: string, text: string, ok: boolean): void;
  dataDir: string;
  protectedPaths?: readonly string[];
  hasBudget(): boolean;
  accountAvailable(input: TurnEndInput): boolean;
  canStart(input: TurnEndInput): boolean;
  waitingOn(input: TurnEndInput): string | null;
  threadAlive(threadId: string): boolean;
  nudge(input: TurnEndInput, text: string): Promise<void>;
  record(row: {
    threadId: string;
    requestId?: string;
    botId?: string;
    botName?: string;
    tool: string;
    summary: string;
    decision: "auto-approved" | "auto-denied";
    rule: string;
  }): void;
}

export function reviewContextFor(asker: ClefAsker | null, event: Opened, protectedPaths: readonly string[] = []): ReviewContext | null {
  if (!asker || asker.guestDriven) return null;
  const verdict = autoVerdict(asker.approvalMode, event.tool, {
    requiresExplicitApproval: event.requiresExplicitApproval,
    commandAllowed: asker.commandAllowed,
  });
  const mayAutoApprove = !verdict.approve && verdict.source === "no-grant" && !event.requiresExplicitApproval &&
    event.approvalScope !== "local-computer" && !event.choices?.length && !ASKS_A_PERSON.test(event.tool);
  const cwd = event.command?.cwd ?? asker.cwd ?? asker.projectRoot;
  return {
    botId: asker.id,
    botName: asker.name,
    mayAutoApprove,
    scope: { ...(cwd ? { cwd } : {}), ...(asker.projectRoot ? { projectRoot: asker.projectRoot } : {}), protectedPaths },
  };
}

const HELD_BACK_WHY = {
  not_worth_showing: "it did not look worth showing",
  secret_likely: "it may show a secret",
} as const;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === "function";

const quietly = <A extends unknown[]>(run: (...args: A) => unknown) => (...args: A): void => {
  try {
    const result = run(...args);
    if (isThenable(result)) void Promise.resolve(result).catch(() => undefined);
  } catch {
    return;
  }
};

export function createClef(deps: ClefDeps) {
  const breaker = createBreaker();
  const record = quietly(deps.record);
  const note = quietly(deps.note);
  const log = quietly((row: Parameters<typeof appendClefLog>[1]) => appendClefLog(deps.dataDir, row));
  const shrink = sipsShrinker();

  const review = createAutoReview({
    decider: deps.decider,
    enabled: () => deciderReady(deps.config(), "autoReview"),
    rules: () => autoReviewRules(deps.config()),
    context: (event) => reviewContextFor(deps.asker(event), event, deps.protectedPaths ?? []),
    deliver: deps.deliver,
    answer: deps.respond,
    note: (event, text, ok) => note(event.threadId, text, ok),
    record: (event, decision, rule, context) => record({
      threadId: event.threadId,
      requestId: event.requestId,
      botId: context.botId,
      botName: context.botName,
      tool: event.tool,
      summary: event.summary,
      decision,
      rule,
    }),
    log,
    breaker,
  });

  const turnEnd = createTurnEndWatcher({
    decider: deps.decider,
    enabled: () => deciderReady(deps.config(), "turnEnd"),
    hasBudget: deps.hasBudget,
    accountAvailable: deps.accountAvailable,
    canStart: deps.canStart,
    waitingOn: deps.waitingOn,
    threadAlive: deps.threadAlive,
    announce: (input, text) => note(input.threadId, text, true),
    nudge: deps.nudge,
    record: log,
    breaker,
  });

  const screen = createScreenCheck({
    decider: deps.decider,
    enabled: () => deciderImagesReady(deps.config(), "screenCheck"),
    record: log,
    shrink,
    breaker,
  });

  const screenshots = createScreenshotFilter({
    decider: deps.decider,
    enabled: () => deciderImagesReady(deps.config(), "screenshotFilter"),
    record: log,
    shrink,
    breaker,
    threadAlive: deps.threadAlive,
  });

  const afterTurn = (input: TurnEndInput): Promise<void> =>
    Promise.resolve()
      .then(() => turnEnd.afterTurn(input))
      .then(() => undefined, () => undefined);

  const finalScreen = (input: { threadId: string; frame: Frame; task: string; reply: string; post(): void }): void => {
    if (!screenshots.active()) {
      input.post();
      return;
    }
    void screenshots.shouldPost(input)
      .then((outcome) => {
        if (outcome.post) input.post();
        else note(input.threadId, `Screenshot held back: ${HELD_BACK_WHY[outcome.reason]}`, true);
      })
      .catch(() => undefined);
  };

  const forgetThread = (threadId: string): void => {
    turnEnd.forget(threadId);
    screenshots.forget(threadId);
  };

  return { review, turnEnd: { ...turnEnd, afterTurn }, screen, screenshots, finalScreen, forgetThread };
}
