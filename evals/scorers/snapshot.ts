import type { Assertion } from "../types.ts";
import type { AssertionResult } from "./assertions.ts";

export interface EvidenceTurn {
  bot: string;
  index: number;
  threadId: string;
  system: string;
  prompt: string;
  toolCalls: Array<{ tool: string; arguments: Record<string, unknown>; errored: boolean }>;
}

export interface HandoffNodeView {
  bot: string;
  status: string;
  threadId: string;
  hasParent?: boolean;
}

export interface SendReceipt {
  bot: string;
  text: string;
  queued: boolean | undefined;
}

export interface WorldSnapshot {
  turns: EvidenceTurn[];
  handoffs: HandoffNodeView[];
  activeThreads: Record<string, string>;
  threads: Record<string, Array<{ role?: string; text?: string; kind?: string; tool?: { name?: string } }>>;
  sends: SendReceipt[];
  observations: Record<string, unknown>;
  activities: (bot: string) => string[];
  resolve: (value: unknown) => unknown;
}

export interface StepResult {
  step: unknown;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  behavior: string;
  world: string;
  pass: boolean;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  assertions: AssertionResult[];
  assertionsInput: Assertion[];
  evidence: {
    turns: EvidenceTurn[];
    handoffs: HandoffNodeView[];
    sends: SendReceipt[];
  };
  error?: string;
}
