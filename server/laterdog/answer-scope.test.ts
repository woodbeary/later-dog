import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { answerScopeOf, recordAnswerScope } from "./answer-scope.ts";

function fakeStore(messages: Message[]) {
  const patches: Array<{ id: string; patch: Partial<Message> }> = [];
  return {
    patches,
    messagesFor: () => messages,
    patchMessage: (_thread: string, id: string, patch: Partial<Message>) => { patches.push({ id, patch }); return undefined; },
  } as never as Parameters<typeof recordAnswerScope>[0] & { patches: typeof patches };
}

const card = (extra: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "c1", role: "bot", kind: "options", at: 1,
  card: { title: "Approval needed", subtitle: "pnpm test", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...extra },
});

describe("how an approval was answered", () => {
  it("is once by default, and nothing for a refusal", () => {
    expect(answerScopeOf("allow", {})).toBe("once");
    expect(answerScopeOf("deny", {})).toBeUndefined();
    expect(answerScopeOf("answer", {})).toBeUndefined();
  });

  it("is always for a remembered command or a saved grant, and chat for the session switch", () => {
    expect(answerScopeOf("allow", { rememberCommand: true })).toBe("always");
    expect(answerScopeOf("allow", { scope: "always" })).toBe("always");
    expect(answerScopeOf("allow", { always: true })).toBe("chat");
    expect(answerScopeOf("allow", { scope: "chat" })).toBe("chat");
  });

  it("ignores anything it does not recognise, so Allow once can never become a standing grant by accident", () => {
    expect(answerScopeOf("allow", { scope: "forever" })).toBe("once");
    expect(answerScopeOf("allow", { scope: { toString: () => "always" } })).toBe("once");
    expect(answerScopeOf("allow", { always: "true", rememberCommand: 1 })).toBe("once");
  });

  it("writes the scope onto the open card and nothing else", () => {
    const store = fakeStore([card()]);
    recordAnswerScope(store, "t1", "r1", "allow", { scope: "once" });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0]!.patch.card).toMatchObject({ answerScope: "once", tool: "Bash", requestId: "r1" });
    expect(store.patches[0]!.patch.card).not.toHaveProperty("answered");
  });

  it("does not label a proposal, which already says what it changed", () => {
    const routine = fakeStore([card({ routineRequest: { version: 1, requestId: "r1", botId: "b", threadId: "t", createdAt: 1, operation: { action: "delete", routineId: "x", expectedUpdatedAt: 1 } } })]);
    recordAnswerScope(routine, "t1", "r1", "allow", {});
    expect(routine.patches).toEqual([]);
  });

  it("leaves a refusal, an answered card and a question alone", () => {
    const refusal = fakeStore([card()]);
    recordAnswerScope(refusal, "t1", "r1", "deny", {});
    const answered = fakeStore([card({ answered: "allow" })]);
    recordAnswerScope(answered, "t1", "r1", "allow", {});
    const question = fakeStore([card({ tool: undefined })]);
    recordAnswerScope(question, "t1", "r1", "allow", {});
    expect([refusal, answered, question].flatMap((store) => store.patches)).toEqual([]);
  });
});
