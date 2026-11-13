import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { Message } from "../store.ts";
import { answerFromGrant, cardGrantKey, cardOnBehalfOf, lastingGrantTarget, lastingRefusal } from "./always-allow-answer.ts";

const root = mkdtempSync(join(tmpdir(), "always-answer-"));
const outside = mkdtempSync(join(tmpdir(), "always-answer-outside-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;
const opened = (extra: Partial<Opened> = {}): Opened => ({
  type: "request.opened", threadId: "t1", provider: "claudeAgent", eventId: "e1", createdAt: "now", requestId: "r1",
  requestType: "permission", tool: "Bash", summary: "git push", command: { command: "git status", cwd: root }, ...extra,
} as Opened);

describe("the key on an engine's card", () => {
  it("is the dog's program key in the owner's turn and nothing in a guest's turn", () => {
    expect(cardGrantKey(opened(), [root], { guestDriven: false })).toBe("run:git status");
    expect(cardGrantKey(opened(), [root], { guestDriven: true })).toBeUndefined();
  });

  it("is nothing for a question, a sandbox escape or a request the engine cannot name", () => {
    expect(cardGrantKey(opened({ requestType: "question" }), [root], { guestDriven: false })).toBeUndefined();
    expect(cardGrantKey(opened({ requiresExplicitApproval: true }), [root], { guestDriven: false })).toBeUndefined();
    expect(cardGrantKey(opened({ tool: "Gmail", command: undefined, grantable: false }), [root], { guestDriven: false })).toBeUndefined();
  });
});

describe("who may give a lasting approval", () => {
  it("refuses a guest's turn and a member who is not an admin", () => {
    const owner = { guestDriven: false, sharedMembers: false, session: true, admin: false };
    expect(lastingRefusal(owner)).toBeNull();
    expect(lastingRefusal({ ...owner, guestDriven: true })).toMatch(/guest/);
    expect(lastingRefusal({ ...owner, sharedMembers: true })).toMatch(/owner or an admin/);
    expect(lastingRefusal({ ...owner, sharedMembers: true, admin: true })).toBeNull();
    expect(lastingRefusal({ ...owner, sharedMembers: true, session: false })).toBeNull();
  });
});

describe("which grant an Always answer stores", () => {
  const card = (extra: Partial<NonNullable<Message["card"]>> = {}): Message => ({
    id: "m1", at: 1, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: "git push", options: [], requestId: "r1", tool: "Bash", allowKey: "run:git push", ...extra },
  });
  const store = (messages: Message[]) => ({ messagesFor: () => messages, botByThread: () => ({ id: "dog-1" }) as never });

  it("stores the card's own key for the dog that asked", () => {
    expect(lastingGrantTarget(store([card()]), "t1", "r1", "allow", { scope: "always" })).toEqual({ botId: "dog-1", key: "run:git push" });
    expect(lastingGrantTarget(store([{ ...card(), from: { botId: "dog-2", name: "Juniper", color: "gold" } }]), "t1", "r1", "allow", { scope: "always" }))
      .toEqual({ botId: "dog-2", key: "run:git push" });
  });

  it("stores nothing for Allow once, a deny, a card with no key, an answered card or a confirmation", () => {
    expect(lastingGrantTarget(store([card()]), "t1", "r1", "allow", {})).toBeNull();
    expect(lastingGrantTarget(store([card()]), "t1", "r1", "deny", { scope: "always" })).toBeNull();
    expect(lastingGrantTarget(store([card({ allowKey: undefined })]), "t1", "r1", "allow", { scope: "always" })).toBeNull();
    expect(lastingGrantTarget(store([card({ answered: "allow" })]), "t1", "r1", "allow", { scope: "always" })).toBeNull();
    expect(lastingGrantTarget(store([card()]), "t1", "r1", "allow", { scope: "always", rememberCommand: true })).toBeNull();
    expect(lastingGrantTarget(store([card({ routineRequest: {} as never })]), "t1", "r1", "allow", { scope: "always" })).toBeNull();
  });
});

describe("a card raised while a dog works for another dog", () => {
  it("names the dog that asked for the work", () => {
    const store = { taskByThread: () => ({ openedBy: { botId: "dog-2", name: "Juniper", kind: "work" as const, at: 1 } }) as never };
    expect(cardOnBehalfOf(store, "dog-1", "dog-1", "t1")).toEqual({ botId: "dog-2", name: "Juniper" });
    expect(cardOnBehalfOf(store, "dog-1", "dog-2", "t1")).toBeUndefined();
    expect(cardOnBehalfOf({ taskByThread: () => undefined }, "dog-1", "dog-1", "t1")).toBeUndefined();
  });
});

describe("the home answering from a lasting approval", () => {
  const deps = (command: string, ownerAllows = false) => ({
    tool: "Bash", command, summary: command,
    guard: { cwd: root, workspaceRoots: [root], tempRoots: [] },
    ownerAllows: () => ownerAllows,
    allow: vi.fn(async () => "allowed-once" as const),
    hold: vi.fn(),
    isCurrent: () => true,
    approved: vi.fn(),
    failed: vi.fn(),
  });

  it("answers allow without a card", async () => {
    const run = deps("ls -la");
    expect(await answerFromGrant(run)).toBe("approved");
    expect(run.allow).toHaveBeenCalledOnce();
    expect(run.hold).not.toHaveBeenCalled();
  });

  it("keeps the owner's hold on deleting outside the dog's folder, even under an exact grant", async () => {
    const run = deps(`rm -rf ${outside} && echo done`);
    expect(await answerFromGrant(run)).toBe("held");
    expect(run.allow).not.toHaveBeenCalled();
    expect(run.hold).toHaveBeenCalledOnce();
    const allowed = deps(`rm -rf ${outside} && echo done`, true);
    expect(await answerFromGrant(allowed)).toBe("approved");
  });

  it("reports an engine that would not take the answer", async () => {
    const run = { ...deps("ls"), allow: vi.fn(async () => "rejected" as const) };
    expect(await answerFromGrant(run)).toBe("failed");
    expect(run.failed).toHaveBeenCalledWith("rejected");
  });
});
