import { describe, expect, it } from "vitest";
import type { TakeoverRequestCardData } from "../../shared/takeover.ts";
import { CREDENTIAL_PROMPT, SIGN_IN_PROMPT } from "../system-prompt.ts";
import {
  finishTakeover,
  nextTakeoverStatus,
  parseTakeoverInput,
  TakeoverWaits,
  takeoverNeedsComputerText,
  takeoverRequestedText,
  takeoverResumePrompt,
  TAKEOVER_PROMPT,
  type TakeoverCards,
  type TakeoverWait,
} from "./takeover.ts";

const card = (status: TakeoverRequestCardData["status"], step = "Sign in to iCloud"): TakeoverRequestCardData => ({
  step,
  reason: "sign-in",
  helpRequestId: "bot-1",
  status,
  place: "cloud",
});

function memoryCards(initial: Array<[TakeoverWait, TakeoverRequestCardData]>): TakeoverCards & { get(wait: TakeoverWait): TakeoverRequestCardData | undefined } {
  const cards = new Map(initial.map(([wait, value]) => [`${wait.threadId}:${wait.messageId}`, value]));
  return {
    read: (wait) => cards.get(`${wait.threadId}:${wait.messageId}`) ?? null,
    write: (wait, next) => void cards.set(`${wait.threadId}:${wait.messageId}`, next),
    get: (wait) => cards.get(`${wait.threadId}:${wait.messageId}`),
  };
}

describe("what the dog asks the person to do on its screen", () => {
  it("keeps the step short and plain and falls back to other for an unknown reason", () => {
    expect(parseTakeoverInput({ step: "  Sign in\n to   iCloud ", reason: "sign-in" })).toEqual({ step: "Sign in to iCloud", reason: "sign-in" });
    expect(parseTakeoverInput({ step: "Pay for the order", reason: "wire money" })).toEqual({ step: "Pay for the order", reason: "other" });
    expect(parseTakeoverInput({ step: "x".repeat(500) })!.step).toHaveLength(200);
    expect(parseTakeoverInput({ step: "   " })).toBeNull();
    expect(parseTakeoverInput({ reason: "captcha" })).toBeNull();
  });
});

describe("the needs-you card following the screen's control", () => {
  it("shows the person in control while they hold the screen", () => {
    expect(nextTakeoverStatus("waiting", { held: true, helpOpen: true })).toBe("in-control");
    expect(nextTakeoverStatus("in-control", { held: true, helpOpen: false })).toBe("in-control");
  });

  it("keeps waiting while the ask is still open", () => {
    expect(nextTakeoverStatus("waiting", { held: false, helpOpen: true })).toBe("waiting");
  });

  it("is done when the person hands back and skipped when the ask closes untouched", () => {
    expect(nextTakeoverStatus("in-control", { held: false, helpOpen: false })).toBe("done");
    expect(nextTakeoverStatus("waiting", { held: false, helpOpen: false })).toBe("skipped");
  });

  it("never reopens a card that already ended", () => {
    for (const status of ["done", "skipped", "replied"] as const) {
      expect(nextTakeoverStatus(status, { held: true, helpOpen: true })).toBe(status);
      expect(finishTakeover(card(status), "done")).toBeNull();
    }
  });

  it("treats a typed reply as the answer only before the person took the screen", () => {
    expect(finishTakeover(card("waiting"), "replied")).toMatchObject({ status: "replied" });
    expect(finishTakeover(card("in-control"), "replied")).toBeNull();
    expect(finishTakeover(card("in-control"), "done")).toMatchObject({ status: "done" });
    expect(finishTakeover(card("waiting"), "skipped")).toMatchObject({ status: "skipped" });
  });
});

describe("waking the dog once the person is finished", () => {
  const first = { botId: "bot", threadId: "t1", messageId: "m1" };
  const second = { botId: "bot", threadId: "t2", messageId: "m2" };

  it("settles every card waiting on that screen once, and only that screen", () => {
    const waits = new TakeoverWaits();
    const other = { botId: "other", threadId: "t3", messageId: "m3" };
    const cards = memoryCards([[first, card("waiting")], [second, card("waiting", "Solve the puzzle")], [other, card("waiting")]]);
    waits.add("bot", first);
    waits.add("bot", second);
    waits.add("other", other);

    expect(waits.settle("bot", { held: true, helpOpen: true }, cards)).toEqual([]);
    expect(cards.get(first)?.status).toBe("in-control");
    expect(cards.get(second)?.status).toBe("in-control");

    const settled = waits.settle("bot", { held: false, helpOpen: false }, cards);
    expect(settled).toEqual([
      { wait: first, outcome: "done", step: "Sign in to iCloud" },
      { wait: second, outcome: "done", step: "Solve the puzzle" },
    ]);
    expect(waits.waiting("bot")).toEqual([]);
    expect(waits.settle("bot", { held: false, helpOpen: false }, cards)).toEqual([]);
    expect(cards.get(other)?.status).toBe("waiting");
    expect(waits.waiting("other")).toEqual([other]);
  });

  it("reports a skip when the ask closes before anyone took the screen", () => {
    const waits = new TakeoverWaits();
    const cards = memoryCards([[first, card("waiting")]]);
    waits.add("bot", first);
    expect(waits.settle("bot", { held: false, helpOpen: false }, cards)).toEqual([{ wait: first, outcome: "skipped", step: "Sign in to iCloud" }]);
    expect(cards.get(first)?.status).toBe("skipped");
  });

  it("drops waits whose card is gone or already ended without waking anyone", () => {
    const waits = new TakeoverWaits();
    const cards = memoryCards([[second, card("replied")]]);
    waits.add("bot", first);
    waits.add("bot", second);
    expect(waits.settle("bot", { held: false, helpOpen: false }, cards)).toEqual([]);
    expect(waits.waiting("bot")).toEqual([]);
    expect(cards.get(second)?.status).toBe("replied");
  });

  it("moves a card to the screen it was re-armed on instead of keeping two waits", () => {
    const waits = new TakeoverWaits();
    waits.add("bot", first);
    waits.add("computer_shared", first);
    expect(waits.waiting("bot")).toEqual([]);
    expect(waits.waiting("computer_shared")).toEqual([first]);
    waits.remove(first);
    expect(waits.waiting("computer_shared")).toEqual([]);
  });
});

describe("what the dog is told", () => {
  it("is told to end the turn, never ask for secrets, and that it will be woken", () => {
    const text = takeoverRequestedText("Sign in to iCloud", false);
    expect(text).toContain("\"Sign in to iCloud\"");
    expect(text).toMatch(/End this turn now/);
    expect(text).toMatch(/Never ask for passwords or codes in chat/);
    expect(text).toMatch(/wakes you automatically/);
    expect(takeoverRequestedText("Sign in", true)).toMatch(/already has the screen/);
  });

  it("is pointed at select_computer instead of refusing when no computer is connected", () => {
    expect(takeoverNeedsComputerText(false)).toMatch(/select_computer/);
    expect(takeoverNeedsComputerText(false)).toMatch(/never a reason to refuse/);
    expect(takeoverNeedsComputerText(true)).toMatch(/switched off/);
    expect(takeoverNeedsComputerText(true)).not.toMatch(/select_computer/);
  });

  it("resumes with a fresh look after a hand-back and without nagging after a skip", () => {
    expect(takeoverResumePrompt("done", "Sign in to iCloud")).toMatch(/fresh screenshot/);
    expect(takeoverResumePrompt("skipped", "Sign in to iCloud")).toMatch(/Do not ask for the same step again right away/);
  });
});

describe("what every dog with later.dog's tools knows up front", () => {
  it("does the legwork, hands over just the human step, and never refuses a sign-in", () => {
    expect(CREDENTIAL_PROMPT.endsWith(TAKEOVER_PROMPT)).toBe(true);
    expect(TAKEOVER_PROMPT.startsWith(" ")).toBe(true);
    expect(TAKEOVER_PROMPT).toMatch(/do all the legwork first/);
    expect(TAKEOVER_PROMPT).toMatch(/a sign-in or code you have no Secure Form for/);
    expect(TAKEOVER_PROMPT).toMatch(/call request_takeover with that one step and end the turn/);
    expect(TAKEOVER_PROMPT).toMatch(/never a reason to refuse or stop/);
    expect(TAKEOVER_PROMPT).toMatch(/passwords and codes never belong in chat/);
    expect(SIGN_IN_PROMPT).toMatch(/with request_takeover when you have it/);
  });
});
