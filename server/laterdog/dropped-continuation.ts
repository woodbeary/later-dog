import type { HandoffRunResult } from "./long-work.ts";

export type ContinuationDrop = "superseded" | "cancelled" | "failed";

const DROP_WORDS: Record<ContinuationDrop, string> = {
  superseded: "Another turn took this chat before it could carry on on the next account.",
  cancelled: "Carrying on on the next account was stopped.",
  failed: "Carrying on on the next account failed.",
};

export interface DropDeps {
  settle(generation: string, outcome: HandoffRunResult): void;
  log(line: string): void;
}

export function dropContinuation(deps: DropDeps, threadId: string, generation: string | undefined, why: ContinuationDrop, detail?: string): void {
  deps.log(`token battery: ${threadId} continuation ${why}${detail ? ` (${detail})` : ""}; its request tree settles as failed so its results still come back`);
  if (generation) deps.settle(generation, { ok: false, text: DROP_WORDS[why] });
}
