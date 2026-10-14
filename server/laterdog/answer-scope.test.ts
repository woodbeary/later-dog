import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { answerScopeOf, confirmRememberedCommand, recordAnswerScope, type GrantLookup } from "./answer-scope.ts";

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

const granted = (...keys: string[]): GrantLookup => ({ hasKey: (_thread, key) => keys.includes(key) });
const none = granted();
const scopeOf = (store: ReturnType<typeof fakeStore>) => (store.patches[0]?.patch.card as { answerScope?: string } | undefined)?.answerScope;

describe("how an approval was answered", () => {
  it("is once by default, and nothing for a refusal", () => {
    expect(answerScopeOf("allow", {})).toBe("once");
    expect(answerScopeOf("deny", {})).toBeUndefined();
    expect(answerScopeOf("answer", {})).toBeUndefined();
  });

  it("claims always for a remembered command or a saved grant, and chat for the session switch", () => {
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
    recordAnswerScope(store, "t1", "r1", "allow", { scope: "once" }, none);
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0]!.patch.card).toMatchObject({ answerScope: "once", tool: "Bash", requestId: "r1" });
    expect(store.patches[0]!.patch.card).not.toHaveProperty("answered");
  });

  it("calls a saved grant Always only when the grant is really on the dog", () => {
    const withKey = card({ allowKey: "peer:delegate_bot:d2" });
    const saved = fakeStore([withKey]);
    recordAnswerScope(saved, "t1", "r1", "allow", { scope: "always" }, granted("peer:delegate_bot:d2"));
    expect(scopeOf(saved)).toBe("always");
    const failed = fakeStore([withKey]);
    recordAnswerScope(failed, "t1", "r1", "allow", { scope: "always" }, none);
    expect(scopeOf(failed)).toBe("once");
    const unkeyed = fakeStore([card()]);
    recordAnswerScope(unkeyed, "t1", "r1", "allow", { scope: "always" }, granted("anything"));
    expect(scopeOf(unkeyed)).toBe("once");
  });

  it("calls a remembered command Allowed once until the rule is really saved", () => {
    const store = fakeStore([card()]);
    recordAnswerScope(store, "t1", "r1", "allow", { rememberCommand: true }, none);
    expect(scopeOf(store)).toBe("once");
    const later = fakeStore([{ ...card({ answered: "allow", answerScope: "once" }) }]);
    confirmRememberedCommand(later, "t1", "r1");
    expect(scopeOf(later)).toBe("always");
  });

  it("does not upgrade a card that was never a once-allowed command", () => {
    const refused = fakeStore([card({ answered: "deny" })]);
    confirmRememberedCommand(refused, "t1", "r1");
    const proposal = fakeStore([card({ answerScope: "once", teamMemoryRequest: { section: "s", entryId: "e", kind: "note" } })]);
    confirmRememberedCommand(proposal, "t1", "r1");
    expect([refused, proposal].flatMap((store) => store.patches)).toEqual([]);
  });

  it("calls it for this chat only when the card offered that", () => {
    const offered = fakeStore([card({ allowSession: true })]);
    recordAnswerScope(offered, "t1", "r1", "allow", { always: true }, none);
    expect(scopeOf(offered)).toBe("chat");
    const notOffered = fakeStore([card()]);
    recordAnswerScope(notOffered, "t1", "r1", "allow", { always: true }, none);
    expect(scopeOf(notOffered)).toBe("once");
  });

  it("never labels a proposal, which already says what it changed or saved", () => {
    const routine = fakeStore([card({ routineRequest: { version: 1, requestId: "r1", botId: "b", threadId: "t", createdAt: 1, operation: { action: "delete", routineId: "x", expectedUpdatedAt: 1 } } })]);
    recordAnswerScope(routine, "t1", "r1", "allow", {}, none);
    const memory = fakeStore([card({ teamMemoryRequest: { section: "s", entryId: "e", kind: "note" } })]);
    recordAnswerScope(memory, "t1", "r1", "allow", { scope: "always" }, granted("k"));
    expect([routine, memory].flatMap((store) => store.patches)).toEqual([]);
  });

  it("leaves a refusal, an answered card and a question alone", () => {
    const refusal = fakeStore([card()]);
    recordAnswerScope(refusal, "t1", "r1", "deny", {}, none);
    const answered = fakeStore([card({ answered: "allow" })]);
    recordAnswerScope(answered, "t1", "r1", "allow", {}, none);
    const question = fakeStore([card({ tool: undefined })]);
    recordAnswerScope(question, "t1", "r1", "allow", {}, none);
    expect([refusal, answered, question].flatMap((store) => store.patches)).toEqual([]);
  });
});
