import type { AskQuestion } from "./ask-question.ts";
import type { Helper } from "./helpers.ts";

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

export interface ModelVariantOption {
  id: string;
  label: string;
}

export interface ModelVariantState {
  options: ModelVariantOption[];
  currentValue?: string;
}

export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
  synthetic?: boolean;
}

export type RuntimeEvent = RuntimeEventBase &
  (
    | {
        type: "session.started"; sessionId: string | null; model?: string | null;
        rebuilt?: boolean;
      }
    | { type: "session.model-variants"; model: string; variants: ModelVariantState }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.retrying";
        attempt: number;
        delayMs: number;
        reason: string;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        usage?: { input: number; output: number; cachedInput?: number };
      }
    | {
        type: "cap.exhausted";
        handoffPath: string;
        reason: "cap";
      }
    | {
        type: "turn.wait_started";
        resource: string;
        position?: number;
        holder?: { name: string; task?: string };
      }
    | {
        type: "turn.wait_ended";
        resource: string;
        holder?: { name: string; task?: string };
        waitedMs: number;
        outcome: "acquired" | "gave_up" | "parked" | "stopped";
      }
    | {
        type: "item.started";
        itemType: "tool" | "reasoning";
        title?: string;
        summary?: string;
        input?: string;
      }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean; output?: string }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    | { type: "item.completed"; itemType: "assistant_image"; data: string; alt?: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string; summary?: boolean }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        command?: { command: string; cwd: string };
        choices?: string[];
        questions?: AskQuestion[];
        origin?: "tool" | "output";
        approvalScope?: "local-computer";
        requiresExplicitApproval?: boolean;
        nativeReview?: "active" | "inactive";
        allowSession?: boolean;
      }
    | {
        type: "request.resolved";
        behavior: "allow" | "deny" | "answer";
        source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
        approvalScope?: "local-computer";
      }
    | {
        type: "thread.token-usage.updated"; input: number; output: number; cachedInput?: number;
        contextTokens?: number; contextWindow?: number;
      }
    | {
        type: "runtime.error"; message: string; setup?: boolean; terminal?: boolean; claudeUpdate?: boolean;
        quota?: { resetsAt?: string; kind?: string };
      }
    | { type: "runtime.notice"; message: string }
    | { type: "helper.updated"; helper: Helper }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;
