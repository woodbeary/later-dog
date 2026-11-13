import type { AccountChoice } from "./account-choice.ts";

export function waitsOnPerson(choice: AccountChoice): boolean {
  return choice.kind === "waiting" && choice.blocked !== "limit";
}

export function accountNeedsYou(input: { keptWaiting: boolean; choice: AccountChoice; name: (instanceId: string) => string | undefined }): string | undefined {
  const { choice } = input;
  if (!input.keptWaiting || choice.kind !== "waiting" || !waitsOnPerson(choice)) return undefined;
  const name = input.name(choice.chosen)?.trim() || choice.chosen;
  return choice.blocked === "off" ? `Turn ${name} back on` : `Sign in to ${name} again`;
}

export function personWaitLog(log: (line: string) => void) {
  const waiting = new Set<string>();
  return {
    waiting(threadId: string, line: string): void {
      if (waiting.has(threadId)) return;
      waiting.add(threadId);
      log(line);
    },
    over(threadId: string, line?: string): boolean {
      if (!waiting.delete(threadId)) return false;
      if (line) log(line);
      return true;
    },
    has(threadId: string): boolean {
      return waiting.has(threadId);
    },
    keepOnly(threadIds: readonly string[]): void {
      const kept = new Set(threadIds);
      for (const threadId of waiting) if (!kept.has(threadId)) waiting.delete(threadId);
    },
  };
}

export type PersonWaitLog = ReturnType<typeof personWaitLog>;
