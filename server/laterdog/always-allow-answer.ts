import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { RequestOutcome } from "../contracts.ts";
import type { Message, Store } from "../store.ts";
import { grantKeyFor } from "./always-allow.ts";
import { ownerGuard, ownerGuardRequest, type OwnerGuardContext, type OwnerGuardRefusal } from "./owner-guard.ts";

type OpenedRequest = Extract<RuntimeEvent, { type: "request.opened" }>;
type Card = NonNullable<Message["card"]>;

export function cardGrantKey(event: OpenedRequest, roots: readonly string[], turn: { guestDriven: boolean }): string | undefined {
  if (turn.guestDriven || event.requestType !== "permission" || event.questions?.length) return undefined;
  return grantKeyFor({
    tool: event.tool,
    command: event.command,
    paths: event.paths,
    roots,
    approvalScope: event.approvalScope,
    requiresExplicitApproval: event.requiresExplicitApproval,
    grantable: event.grantable,
  });
}

export function cardOnBehalfOf(
  store: Pick<Store, "taskByThread">,
  ownerId: string | undefined,
  askerId: string,
  threadId: string,
): { botId: string; name: string } | undefined {
  const opener = ownerId ? store.taskByThread(ownerId, threadId)?.openedBy : undefined;
  return opener && opener.botId !== askerId ? { botId: opener.botId, name: opener.name } : undefined;
}

export interface Granter {
  guestDriven: boolean;
  sharedMembers: boolean;
  session: boolean;
  admin: boolean;
}

export function lastingRefusal(granter: Granter): string | null {
  if (granter.guestDriven) return "A guest's turn can't be allowed always. Allow it once instead.";
  if (granter.session && granter.sharedMembers && !granter.admin) return "Only the owner or an admin can allow this always. Allow it once instead.";
  return null;
}

function isProposal(card: Card): boolean {
  return Boolean(card.routineRequest || card.skillRequest || card.profileRequest || card.modelRequest ||
    card.questionRequest || card.takeoverRequest);
}

export function lastingGrantTarget(
  store: Pick<Store, "messagesFor" | "botByThread">,
  threadId: string,
  requestId: string,
  behavior: string,
  body: { scope?: unknown; rememberCommand?: unknown },
): { botId: string; key: string } | null {
  if (behavior !== "allow" || body.scope !== "always" || body.rememberCommand === true) return null;
  const message = store.messagesFor(threadId).find((candidate) =>
    candidate.card?.requestId === requestId && !candidate.card.answered && candidate.card.dismissed !== true);
  const card = message?.card;
  if (!message || !card?.allowKey || !card.tool || isProposal(card)) return null;
  const botId = message.from?.botId ?? store.botByThread(threadId)?.id;
  return botId ? { botId, key: card.allowKey } : null;
}

export interface GrantAnswerDeps {
  tool: string;
  command?: string;
  summary: string;
  guard: OwnerGuardContext;
  ownerAllows: (refusal: OwnerGuardRefusal) => boolean;
  allow: () => Promise<RequestOutcome | "failed">;
  hold: (question: string, refusal: OwnerGuardRefusal) => void;
  isCurrent: () => boolean;
  approved: () => void;
  failed: (outcome: RequestOutcome | "failed") => void;
}

export type GrantAnswer = "approved" | "held" | "failed" | "stale";

export async function answerFromGrant(deps: GrantAnswerDeps): Promise<GrantAnswer> {
  const found = await ownerGuard(ownerGuardRequest(deps.tool, deps.command, deps.summary), deps.guard);
  if (found && !deps.ownerAllows(found)) {
    deps.hold(found.ask ?? found.message, found);
    return "held";
  }
  const outcome = await deps.allow();
  if (!deps.isCurrent()) return "stale";
  if (outcome !== "allowed-once") {
    deps.failed(outcome);
    return "failed";
  }
  deps.approved();
  return "approved";
}
