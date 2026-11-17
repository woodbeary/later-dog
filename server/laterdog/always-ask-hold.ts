export type HeldAnswer = "allow" | "deny" | "timeout";
export type HoldOutcome = HeldAnswer | "gone";

export interface HoldDeps {
  caller: AbortSignal;
  open(): { requestId: string; answer: Promise<HeldAnswer> };
  show(requestId: string): void;
  late(requestId: string): void;
  forget(requestId: string): void;
}

export async function holdForPerson(deps: HoldDeps): Promise<HoldOutcome> {
  if (deps.caller.aborted) return "gone";
  const held = deps.open();
  deps.show(held.requestId);
  const gone = new Promise<"gone">((resolve) => {
    if (deps.caller.aborted) resolve("gone");
    else deps.caller.addEventListener("abort", () => resolve("gone"), { once: true });
  });
  const answer = await Promise.race([held.answer, gone]);
  deps.forget(held.requestId);
  if (answer === "gone" || deps.caller.aborted) {
    deps.late(held.requestId);
    return "gone";
  }
  return answer;
}

export function callerGone(res: { destroyed?: boolean; writableEnded?: boolean; socket?: { destroyed?: boolean } | null }): boolean {
  return !res.writableEnded && (res.destroyed === true || res.socket?.destroyed === true);
}
