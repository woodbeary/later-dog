
import type { ApprovalMode } from "../shared/approval-mode.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import type { ProviderAdapter, RequestOutcome } from "./contracts.ts";

export async function deliverFullAccessApproval(
  adapter: Pick<ProviderAdapter, "respondToRequest" | "interruptTurn"> | undefined,
  threadId: string,
  requestId: string,
  turnId?: string,
  isCurrent: () => boolean = () => false,
): Promise<RequestOutcome | "failed"> {
  if (!adapter) return "failed";
  try {
    return await adapter.respondToRequest(threadId, requestId, { behavior: "allow" });
  } catch {
    if (turnId && isCurrent()) await adapter.interruptTurn(threadId, turnId).catch(() => {});
    return "failed";
  }
}

export function approvalModeForOrigin(mode: ApprovalMode, origin: { peerInitiated: boolean }): ApprovalMode {
  if (mode === "custom" && origin.peerInitiated) return "auto";
  return mode;
}

const ASKS_A_PERSON = new Set(["askuserquestion", "ask_user"]);

const WEB_SEARCH = new Set(["websearch", "web_search", "web-search", "search_web"]);

function bareToolName(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
}

export type AutoVerdictSource =
  | "full-access"
  | "command-allowlist"
  | "web-search"
  | "native-approval"
  | "explicit-approval-block"
  | "outbound-guard"
  | "owner-auto"
  | "owner-guard"
  | "no-grant";

export interface AutoVerdict {
  approve: string | null;
  source: AutoVerdictSource;
}

export function autoVerdict(
  mode: ApprovalMode,
  tool: string,
  context?: {
    requiresExplicitApproval?: boolean;
    commandAllowed?: boolean;
  },
): AutoVerdict {
  if (ASKS_A_PERSON.has(bareToolName(tool))) {
    return { approve: null, source: "no-grant" };
  }
  if (mode === "full") return { approve: `approved ${tool} (full access)`, source: "full-access" };
  if (context?.requiresExplicitApproval) return { approve: null, source: "explicit-approval-block" };
  if (isOutboundTool(tool)) return { approve: null, source: "outbound-guard" };
  if (context?.commandAllowed) return { approve: `approved ${tool} (saved command)`, source: "command-allowlist" };
  if (mode === "auto" && WEB_SEARCH.has(bareToolName(tool))) {
    return { approve: `approved ${tool} (web search)`, source: "web-search" };
  }
  if (mode === "auto" || mode === "custom") return { approve: null, source: "native-approval" };
  return { approve: null, source: "no-grant" };
}

export const HELD_NOTE = {
  "approval.held.outbound": "This sends something on your behalf, so it always asks first.",
  "approval.held.native": "This always asks you first.",
  "approval.held.sandbox":
    "This changes the provider sandbox, so only Full access can approve it automatically.",
  "approval.held.undeliveredFull": "Full access couldn't deliver this approval.",
  "approval.held.undelivered": "Off-leash couldn't answer this one.",
} as const;

export type HeldNoteKey = keyof typeof HELD_NOTE;

export function approvalHeldNote(context: {
  source?: AutoVerdictSource;
  permission: boolean;
}): HeldNoteKey | undefined {
  if (!context.permission) return undefined;
  if (context.source === "outbound-guard") return "approval.held.outbound";
  if (context.source === "explicit-approval-block") return "approval.held.sandbox";
  if (context.source === "native-approval") return "approval.held.native";
  return undefined;
}

export function approvalHeldReason(context: {
  source?: AutoVerdictSource;
  permission: boolean;
}): string | undefined {
  const key = approvalHeldNote(context);
  return key && HELD_NOTE[key];
}
