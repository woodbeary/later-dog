import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { AppConfig } from "../config.ts";
import { autoVerdict } from "../auto-approve.ts";
import type { RequestOutcome } from "../contracts.ts";
import { deciderReady, type Decider } from "../decider/index.ts";
import { createAutoReview, type ReviewContext } from "./clef-auto-review.ts";
import { autoReviewRules } from "./clef-config.ts";

type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;

const ASKS_A_PERSON = /^(mcp__[^_]+__)?(askuserquestion|ask_user)$/i;

export interface ClefAsker {
  id: string;
  name: string;
  approvalMode: ApprovalMode;
  commandAllowed: boolean;
  guestDriven: boolean;
}

export interface ClefDeps {
  decider: Pick<Decider, "ask">;
  config(): AppConfig;
  deliver(event: RuntimeEvent): void;
  asker(event: Opened): ClefAsker | null;
  respond(event: Opened, behavior: "allow" | "deny", message?: string): Promise<RequestOutcome | "failed">;
  note(threadId: string, text: string, ok: boolean): void;
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

export function reviewContextFor(asker: ClefAsker | null, event: Opened): ReviewContext | null {
  if (!asker || asker.guestDriven) return null;
  const verdict = autoVerdict(asker.approvalMode, event.tool, {
    requiresExplicitApproval: event.requiresExplicitApproval,
    commandAllowed: asker.commandAllowed,
  });
  if (verdict.approve) return null;
  return {
    botId: asker.id,
    botName: asker.name,
    mayAutoApprove: verdict.source === "no-grant" && !event.requiresExplicitApproval && !ASKS_A_PERSON.test(event.tool),
  };
}

export function createClef(deps: ClefDeps) {
  const review = createAutoReview({
    decider: deps.decider,
    enabled: () => deciderReady(deps.config(), "autoReview"),
    rules: () => autoReviewRules(deps.config()),
    context: (event) => reviewContextFor(deps.asker(event), event),
    deliver: deps.deliver,
    answer: deps.respond,
    note: (event, text, ok) => deps.note(event.threadId, text, ok),
    record: (event, decision, rule, context) => deps.record({
      threadId: event.threadId,
      requestId: event.requestId,
      botId: context.botId,
      botName: context.botName,
      tool: event.tool,
      summary: event.summary,
      decision,
      rule,
    }),
  });
  return { review };
}
