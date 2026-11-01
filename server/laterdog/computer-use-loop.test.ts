import { describe, expect, it } from "vitest";
import type { MessagesRequest } from "./computer-use-anthropic.ts";
import type { DoneRule, PageCheck } from "./computer-use-done.ts";
import {
  ACTION_MS, FakeClock, FakeDesktop, finished, fixedPageCheck, FIXTURE_USAGE, FIXTURE_VIEWER, memoryStore, MODEL_MS, reply, ScriptedMessages, ScriptedScreenChecks,
  takeoverUse, toolUse, WatchedControl, type ScriptedReply,
} from "./computer-use-fakes.ts";
import type { DesktopAction, FormNotice } from "./computer-use-loop.ts";
import { RunSecureForms } from "./computer-use-secure-form.ts";
import {
  DEFAULT_LIMITS, HANDED_BACK_NOTE, NOT_APPROVED, NOT_EXECUTED, runComputerUse, sameModel, SCREEN_TAKEN, screenshotSha256, SUBMISSION_UNKNOWN, TAKEN_OVER,
  UNKNOWN_PENDING, type LoopLimits, type TakeoverNotice,
} from "./computer-use-loop.ts";

const PERSON_ONLY: DoneRule = { pageCheck: null };
const WITH_PAGE: DoneRule = { pageCheck: { url: "https://clinic.example/requests/42", contains: "Request received" } };
const UNCHECKED = { screenState: null, screenProbability: null, outcome: null, thinking: null, failureClass: null };
const SIGN_IN = { screen: "login" as const, probability: 0.93 };
const PASSES = { passed: true, detail: "HTTP 200; the page shows the expected text." };
const FAILS = { passed: false, detail: "HTTP 200; the expected text is not on the page." };

function setup(replies: ScriptedReply[], options: { done?: DoneRule; pageCheck?: PageCheck; size?: { width: number; height: number };
  fail?: (action: DesktopAction) => string | null; limits?: LoopLimits; model?: string; screenChecks?: ScriptedScreenChecks; forms?: RunSecureForms;
  picture?: (n: number) => string } = {}) {
  const clock = new FakeClock();
  const store = memoryStore();
  const desktop = new FakeDesktop({ clock, size: options.size, fail: options.fail, ...(options.picture ? { picture: options.picture } : {}) });
  const messages = new ScriptedMessages(replies, { clock, model: options.model });
  const control = new WatchedControl();
  const pageCheck = options.pageCheck ?? fixedPageCheck(PASSES);
  const notices: TakeoverNotice[] = [];
  const formNotices: FormNotice[] = [];
  const run = store.start({ task: "Send the interpreter request for Tuesday", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: options.done ?? PERSON_ONLY });
  const go = () => runComputerUse(run.id, { store, desktop, messages, control, pageCheck, clock: clock.read,
    sleep: async (ms) => clock.advance(ms), limits: options.limits ?? DEFAULT_LIMITS, notify: (notice) => notices.push(notice),
    notifyForm: (notice) => formNotices.push(notice),
    ...(options.screenChecks ? { screenChecks: options.screenChecks } : {}), ...(options.forms ? { forms: options.forms } : {}) });
  return { clock, store, desktop, messages, control, run, go, notices, formNotices };
}

const lastUser = (request: MessagesRequest) => request.messages.at(-1)!;
const results = (request: MessagesRequest) => lastUser(request).content.filter((block) => block.type === "tool_result");
const texts = (request: MessagesRequest) => lastUser(request).content.flatMap((block) => (block.type === "text" ? [block.text] : []));

describe("done is never the model's call", () => {
  it("waits for the person when Claude ends its turn on a run with no page check", async () => {
    const { go, store, run } = setup([finished("I sent the request.")]);
    const ended = await go();
    expect(ended).toMatchObject({ state: "awaiting_done", doneSource: null, failure: null, detail: "Claude says it is finished: I sent the request." });
    expect(store.finish(run.id, { done: "person" })).toMatchObject({ state: "done", doneSource: "person" });
  });

  it("marks the run done when the configured live-page check passes", async () => {
    const check = fixedPageCheck(PASSES);
    const { go } = setup([finished("Sent.")], { done: WITH_PAGE, pageCheck: check });
    expect(await go()).toMatchObject({ state: "done", doneSource: "page_check", detail: PASSES.detail });
    expect(check.calls).toBe(1);
  });

  it("leaves the run to the person when the page check does not pass", async () => {
    const { go } = setup([finished("Sent.")], { done: WITH_PAGE, pageCheck: fixedPageCheck(FAILS) });
    const ended = await go();
    expect(ended).toMatchObject({ state: "awaiting_done", doneSource: null });
    expect(ended.detail).toContain(FAILS.detail);
  });

  it("gives Claude no tool that could mark a run done", async () => {
    const { go, messages } = setup([finished("Done.")]);
    await go();
    expect(JSON.stringify(messages.requests[0]!.system)).toContain("You cannot mark the task done");
  });
});

describe("every step is logged", () => {
  it("keeps the action, the hash of the screenshot Claude saw, latency and tokens", async () => {
    const { go, store, run, desktop } = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [640, 400] }), toolUse("toolu_2", "type", { text: "Tuesday 10am" })]),
      reply([toolUse("toolu_3", "screenshot")]),
      finished("Filled in the time."),
    ]);
    await go();
    const first = screenshotSha256(Buffer.from("fixture frame 1 at 1280x800"));
    const second = screenshotSha256(Buffer.from("fixture frame 2 at 1280x800"));
    expect(store.steps(run.id)).toEqual([
      { step: 1, at: expect.any(String), actions: [{ name: "left_click", coordinate: [640, 400] }, { name: "type", text: "12 characters" }],
        screenshotSha256: first, modelMs: MODEL_MS, actionMs: 2 * ACTION_MS, ...FIXTURE_USAGE, ...UNCHECKED, screenUnchanged: false },
      { step: 2, at: expect.any(String), actions: [{ name: "screenshot" }], screenshotSha256: first, modelMs: MODEL_MS, actionMs: ACTION_MS, ...FIXTURE_USAGE, ...UNCHECKED, screenUnchanged: null },
      { step: 3, at: expect.any(String), actions: [], screenshotSha256: second, modelMs: MODEL_MS, actionMs: 0, ...FIXTURE_USAGE, ...UNCHECKED, screenUnchanged: null },
    ]);
    expect(desktop.acted).toEqual([{ kind: "click", button: "left", count: 1, at: [640, 400], modifiers: [] }, { kind: "type", text: "Tuesday 10am" }]);
  });
});

describe("what each step keeps for a failure review", () => {
  it("keeps Claude's summarized thinking for the step", async () => {
    const { go, store, run } = setup([
      reply([{ type: "thinking", thinking: "The request form is open; I will pick Tuesday.", signature: "fixture" }, toolUse("toolu_1", "key", { text: "Tab" })]),
      reply([{ type: "thinking", thinking: "", signature: "fixture" }, { type: "redacted_thinking", data: "fixture" }, { type: "text", text: "Done." }], "end_turn"),
    ]);
    await go();
    expect(store.steps(run.id).map((step) => step.thinking)).toEqual(["The request form is open; I will pick Tuesday.", null]);
  });

  it("flags an action after which the next screenshot did not change, in the same step or a later one", async () => {
    const still = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [10, 10] }), toolUse("toolu_2", "screenshot")]),
      reply([toolUse("toolu_3", "type", { text: "x" })]),
      reply([toolUse("toolu_4", "wait", { duration: 1 })]),
      reply([toolUse("toolu_5", "screenshot")]),
      finished("Done."),
    ], { picture: () => "the same frame every time" });
    await still.go();
    expect(still.store.steps(still.run.id).map((step) => step.screenUnchanged)).toEqual([true, true, null, null, null]);
    const moving = setup([reply([toolUse("toolu_1", "left_click", { coordinate: [10, 10] }), toolUse("toolu_2", "screenshot")]), finished("Done.")]);
    await moving.go();
    expect(moving.store.steps(moving.run.id).map((step) => step.screenUnchanged)).toEqual([false, null]);
  });
});

describe("the conversation with the computer toolset", () => {
  it("starts with the task and a screenshot, and answers every call with its toolset name", async () => {
    const { go, messages } = setup([
      reply([toolUse("toolu_1", "screenshot"), toolUse("toolu_2", "key", { text: "ctrl+l" })]),
      finished("Done."),
    ]);
    await go();
    const [first, second] = messages.requests;
    expect(first!.messages[0]!.content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(first!.messages[0]!.content[0]).toEqual({ type: "text", text: "Task: Send the interpreter request for Tuesday" });
    expect(results(second!)).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", toolset_name: "computer", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("fixture frame 2 at 1280x800").toString("base64") } }] },
      { type: "tool_result", tool_use_id: "toolu_2", toolset_name: "computer", content: [{ type: "text", text: "OK" }] },
    ]);
  });

  it("sends a big screen at the documented size and clicks where Claude pointed", async () => {
    const { go, desktop, messages } = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [864, 540] }), toolUse("toolu_2", "cursor_position")]),
      finished("Clicked."),
    ], { size: { width: 2560, height: 1600 } });
    await go();
    expect(desktop.frames[0]).toEqual({ width: 1728, height: 1080 });
    expect(desktop.acted[0]).toEqual({ kind: "click", button: "left", count: 1, at: [1280, 800], modifiers: [] });
    expect(results(messages.requests[1]!)[1]!.content).toEqual([{ type: "text", text: "X=864, Y=540" }]);
  });

  it("stops a batch at the first failure and says so for the rest", async () => {
    const { go, desktop, messages } = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [10, 10] }), toolUse("toolu_2", "left_click", { coordinate: [5000, 10] }), toolUse("toolu_3", "key", { text: "Return" })]),
      finished("Done."),
    ]);
    await go();
    expect(desktop.acted).toHaveLength(1);
    const answered = results(messages.requests[1]!);
    expect(answered.map((result) => result.is_error ?? false)).toEqual([false, true, true]);
    expect(answered[2]!.content).toEqual([{ type: "text", text: NOT_EXECUTED }]);
  });

  it("reports a desktop failure to Claude and carries on", async () => {
    const { go, messages } = setup([
      reply([toolUse("toolu_1", "key", { text: "Return" })]),
      finished("Done."),
    ], { fail: () => "xdotool: no display" });
    expect((await go()).state).toBe("awaiting_done");
    expect(results(messages.requests[1]!)[0]).toMatchObject({ is_error: true, content: [{ type: "text", text: "Error: xdotool: no display" }] });
  });
});

describe("take over", () => {
  it("logs Claude's request with its cause, waits for the person, and resumes", async () => {
    const h = setup([
      reply([takeoverUse("toolu_1", "Sign in to the clinic portal", "sign-in"), toolUse("toolu_2", "left_click", { coordinate: [1, 1] })]),
      finished("Sent."),
    ]);
    const held = h.control.waitingForPerson();
    const ended = h.go();
    await held;
    expect(h.store.run(h.run.id).state).toBe("handed_over");
    expect(h.store.handoffs(h.run.id)).toEqual([expect.objectContaining({ cause: "sign-in", askedBy: "model", note: "Sign in to the clinic portal", returnedAt: null,
      viewerUrl: FIXTURE_VIEWER.url, viewerExpiresAt: FIXTURE_VIEWER.expiresAt })]);
    expect(h.notices).toEqual([{ runId: h.run.id, task: "Send the interpreter request for Tuesday", handoff: expect.objectContaining({ number: 1, viewerUrl: FIXTURE_VIEWER.url }) }]);
    h.clock.advance(120_000);
    h.store.handBack(h.run.id);
    h.control.release();
    expect((await ended).state).toBe("awaiting_done");
    expect(h.desktop.acted).toEqual([]);
    const answered = results(h.messages.requests[1]!);
    expect(answered[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: expect.stringContaining("handed the screen back") }] });
    expect(answered[1]).toMatchObject({ toolset_name: "computer", is_error: true });
    expect(h.store.steps(h.run.id)[0]!.actionMs).toBe(0);
    expect(h.store.handoffs(h.run.id)[0]!.returnedAt).not.toBeNull();
  });

  it("still hands the screen over when the viewer link cannot be minted", async () => {
    const h = setup([reply([takeoverUse("toolu_1", "Solve the CAPTCHA", "captcha")]), finished("Sent.")]);
    h.desktop.viewerFails = true;
    const held = h.control.waitingForPerson();
    const ended = h.go();
    await held;
    expect(h.store.openHandoff(h.run.id)).toMatchObject({ cause: "captcha", viewerUrl: null });
    expect(h.notices).toHaveLength(1);
    h.store.handBack(h.run.id);
    h.control.release();
    expect((await ended).state).toBe("awaiting_done");
  });

  it("logs the person taking the screen on their own, and tells Claude when it comes back", async () => {
    let h!: ReturnType<typeof setup>;
    h = setup([
      () => {
        h.store.handOver(h.run.id, "person", "person", "");
        h.control.hold();
        return reply([toolUse("toolu_1", "left_click", { coordinate: [1, 1] })]);
      },
      finished("Done."),
    ]);
    const held = h.control.waitingForPerson();
    const ended = h.go();
    await held;
    h.store.handBack(h.run.id);
    h.control.release();
    await ended;
    expect(h.desktop.acted).toEqual([]);
    const second = h.messages.requests[1]!;
    expect(results(second)[0]!.content).toEqual([{ type: "text", text: TAKEN_OVER }]);
    expect(texts(second)).toEqual([HANDED_BACK_NOTE]);
    expect(h.store.handoffs(h.run.id)).toEqual([expect.objectContaining({ cause: "person", askedBy: "person" })]);
  });
});

describe("the screen check as a second take-over trigger", () => {
  const loginOnFirstFrame = () => new ScriptedScreenChecks({ states: (frame) => (frame.startsWith("fixture frame 1 ") ? SIGN_IN : { screen: "ready", probability: 0.96 }) });

  it("hands the screen to the person when Claude acts on a sign-in screen without asking", async () => {
    const checks = loginOnFirstFrame();
    const h = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [640, 400] }), toolUse("toolu_2", "type", { text: "jacob@example.com" })]),
      reply([toolUse("toolu_3", "screenshot")]),
      finished("Signed in and sent."),
    ], { screenChecks: checks });
    const held = h.control.waitingForPerson();
    const ended = h.go();
    await held;
    expect(h.store.openHandoff(h.run.id)).toMatchObject({ cause: "sign-in", askedBy: "screen_check", probability: 0.93, viewerUrl: FIXTURE_VIEWER.url,
      note: "The screen check saw login (0.93) and Claude went on without asking for the person." });
    expect(h.desktop.acted).toEqual([]);
    h.store.handBack(h.run.id);
    h.control.release();
    expect((await ended).state).toBe("awaiting_done");
    const second = h.messages.requests[1]!;
    expect(results(second).map((result) => result.content)).toEqual([[{ type: "text", text: SCREEN_TAKEN }], [{ type: "text", text: TAKEN_OVER }]]);
    expect(texts(second)).toEqual([HANDED_BACK_NOTE]);
    expect(h.store.steps(h.run.id).map((step) => [step.screenState, step.screenProbability])).toEqual([["login", 0.93], ["login", 0.93], ["ready", 0.96]]);
    expect(h.notices.map((notice) => notice.handoff.askedBy)).toEqual(["screen_check"]);
  });

  it("does not hand the same sign-in screen over twice, and leaves it alone once Claude asked for the person", async () => {
    const checks = new ScriptedScreenChecks({ states: () => SIGN_IN });
    const h = setup([
      reply([takeoverUse("toolu_1", "Sign in to the clinic portal", "sign-in")]),
      reply([toolUse("toolu_2", "left_click", { coordinate: [640, 400] })]),
      finished("Sent."),
    ], { screenChecks: checks });
    const held = h.control.waitingForPerson();
    const ended = h.go();
    await held;
    h.store.handBack(h.run.id);
    h.control.release();
    await ended;
    expect(h.store.handoffs(h.run.id).map((handoff) => handoff.askedBy)).toEqual(["model"]);
    expect(h.desktop.acted).toHaveLength(1);
  });

  it("lets Claude look and wait on a sign-in screen without handing it over", async () => {
    const checks = new ScriptedScreenChecks({ states: () => SIGN_IN });
    const h = setup([reply([toolUse("toolu_1", "screenshot"), toolUse("toolu_2", "wait", { duration: 1 }), toolUse("toolu_3", "mouse_move", { coordinate: [5, 5] })]), finished("Waiting.")], { screenChecks: checks });
    expect((await h.go()).state).toBe("awaiting_done");
    expect(h.store.handoffs(h.run.id)).toEqual([]);
    expect(checks.looked).toEqual(["fixture frame 1 at 1280x800", "fixture frame 2 at 1280x800"]);
  });

  it("does nothing on an unsure check, or with screen checks off", async () => {
    const unsure = setup([reply([toolUse("toolu_1", "key", { text: "Return" })]), finished("Done.")], { screenChecks: new ScriptedScreenChecks({ states: () => ({ screen: "captcha", probability: 0.31 }) }) });
    await unsure.go();
    expect(unsure.store.handoffs(unsure.run.id)).toEqual([]);
    expect(unsure.desktop.acted).toHaveLength(1);
    const off = setup([reply([toolUse("toolu_1", "key", { text: "Return" })]), finished("Done.")]);
    await off.go();
    expect(off.store.steps(off.run.id)[0]).toMatchObject(UNCHECKED);
  });
});

describe("the guard on clicks that submit, pay, publish, cancel or delete", () => {
  const SUBMIT = { coordinate: [900, 700] };
  const submitIsIrreversible = () => new ScriptedScreenChecks({ irreversible: (action) => (action === "left_click at (900, 700)" ? 0.94 : 0.03), confirmed: () => 0.08 });

  async function approveWhenAsked(h: ReturnType<typeof setup>, approve: boolean) {
    await h.control.waitingForPerson();
    h.store.handBack(h.run.id);
    h.control.release(approve);
  }

  it("asks on a crop around the target, holds for the person, and never clicks Submit a second time when the outcome is unknown", async () => {
    const checks = submitIsIrreversible();
    const h = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [200, 300] }), toolUse("toolu_2", "left_click", SUBMIT), toolUse("toolu_3", "screenshot")]),
      reply([toolUse("toolu_4", "left_click", SUBMIT)]),
      finished("I sent the request."),
    ], { screenChecks: checks, done: WITH_PAGE, pageCheck: fixedPageCheck(FAILS) });
    const ended = h.go();
    await approveWhenAsked(h, true);
    const run = await ended;
    const submits = h.desktop.acted.filter((action) => action.kind === "click" && action.at?.[0] === 900);
    expect(submits).toHaveLength(1);
    expect(h.desktop.acted.filter((action) => action.kind === "click")).toHaveLength(2);
    expect(h.desktop.crops).toEqual([{ x: 0, y: 180, width: 480, height: 240 }, { x: 660, y: 560, width: 480, height: 240 }]);
    expect(h.store.handoffs(h.run.id)).toEqual([expect.objectContaining({ cause: "confirm", askedBy: "guard", probability: 0.94, viewerUrl: null,
      note: "Claude wants to left_click at (900, 700); it looks like it submits, pays, publishes, cancels or deletes something." })]);
    const second = h.messages.requests[1]!;
    expect(results(second).map((result) => [result.is_error ?? false, result.content])).toEqual([
      [false, [{ type: "text", text: "OK" }]], [true, [{ type: "text", text: SUBMISSION_UNKNOWN }]], [true, [{ type: "text", text: NOT_EXECUTED }]],
    ]);
    expect(results(h.messages.requests[2]!)[0]!.content).toEqual([{ type: "text", text: UNKNOWN_PENDING }]);
    expect(h.store.steps(h.run.id).map((step) => step.outcome)).toEqual(["submission_unknown", null, null]);
    expect(run).toMatchObject({ state: "submission_unknown", doneSource: null });
    expect(run.detail).toContain("Whether a submit went through is unknown.");
    expect(checks.asked.filter((asked) => asked.question === "confirmed")).toHaveLength(3);
  });

  it("settles an unknown submit at once when the page check shows it went through, with no second click", async () => {
    const check = fixedPageCheck(PASSES);
    const h = setup([reply([toolUse("toolu_1", "left_click", SUBMIT)]), reply([toolUse("toolu_2", "left_click", SUBMIT)])],
      { screenChecks: submitIsIrreversible(), done: WITH_PAGE, pageCheck: check });
    const ended = h.go();
    await approveWhenAsked(h, true);
    expect(await ended).toMatchObject({ state: "done", doneSource: "page_check", detail: `${PASSES.detail} That settled a submit whose outcome was unknown.` });
    expect(h.desktop.acted).toHaveLength(1);
    expect(h.messages.requests).toHaveLength(1);
    expect(check.calls).toBe(1);
  });

  it("settles an unknown submit when Claude ends its turn and the page check then passes, after refusing the repeat", async () => {
    let calls = 0;
    const later = Object.assign(async () => (++calls === 1 ? FAILS : PASSES), { calls: 0 });
    const h = setup([reply([toolUse("toolu_1", "left_click", SUBMIT)]), reply([toolUse("toolu_2", "left_click", SUBMIT)]), finished("Sent.")],
      { screenChecks: submitIsIrreversible(), done: WITH_PAGE, pageCheck: later });
    const ended = h.go();
    await approveWhenAsked(h, true);
    expect(await ended).toMatchObject({ state: "done", doneSource: "page_check", detail: `${PASSES.detail} That settled a submit whose outcome was unknown.` });
    expect(calls).toBe(2);
    expect(h.desktop.acted).toHaveLength(1);
  });

  it("marks a submit unknown when the desktop fails during the click, and leaves the run to the person without a page check", async () => {
    const h = setup([reply([toolUse("toolu_1", "left_click", SUBMIT)]), finished("Sent.")],
      { screenChecks: submitIsIrreversible(), fail: (action) => (action.kind === "click" ? "later.dog's computers service could not be reached or did not answer in time" : null) });
    const ended = h.go();
    await approveWhenAsked(h, true);
    expect(await ended).toMatchObject({ state: "submission_unknown" });
    expect(results(h.messages.requests[1]!)[0]!.content).toEqual([{ type: "text", text: SUBMISSION_UNKNOWN }]);
    expect(h.store.finish(h.run.id, { done: "person" })).toMatchObject({ state: "done", doneSource: "person" });
  });

  it("clicks once and goes on when the page confirms it", async () => {
    const checks = new ScriptedScreenChecks({ irreversible: () => 0.9, confirmed: () => 0.97 });
    const h = setup([reply([toolUse("toolu_1", "left_click", SUBMIT)]), finished("Sent.")], { screenChecks: checks });
    const ended = h.go();
    await approveWhenAsked(h, true);
    expect(await ended).toMatchObject({ state: "awaiting_done" });
    expect(results(h.messages.requests[1]!)[0]!.content).toEqual([{ type: "text", text: "OK" }]);
    expect(h.store.steps(h.run.id)[0]!.outcome).toBeNull();
    expect(checks.asked.filter((asked) => asked.question === "confirmed")).toHaveLength(1);
  });

  it("runs nothing the person did not approve", async () => {
    const h = setup([reply([toolUse("toolu_1", "key", { text: "Return" }), toolUse("toolu_2", "left_click", { coordinate: [5, 5] })]), finished("Done.")],
      { screenChecks: new ScriptedScreenChecks({ irreversible: (action) => (action === "key Return" ? 0.71 : 0.01) }) });
    const ended = h.go();
    await approveWhenAsked(h, false);
    await ended;
    expect(h.desktop.acted).toEqual([]);
    expect(h.desktop.crops).toEqual([]);
    expect(results(h.messages.requests[1]!).map((result) => result.content)).toEqual([[{ type: "text", text: NOT_APPROVED }], [{ type: "text", text: expect.stringContaining("handed to the person") }]]);
  });

  it("holds for the person when the guard cannot check a click, and leaves ordinary clicks and right clicks alone", async () => {
    const unsure = setup([reply([toolUse("toolu_1", "left_click", SUBMIT)]), finished("Done.")], { screenChecks: new ScriptedScreenChecks({ irreversible: () => null }) });
    const ended = unsure.go();
    await approveWhenAsked(unsure, false);
    await ended;
    expect(unsure.store.handoffs(unsure.run.id)[0]).toMatchObject({ cause: "confirm", askedBy: "guard", probability: null });
    const plain = setup([reply([toolUse("toolu_1", "left_click", { coordinate: [10, 10] }), toolUse("toolu_2", "right_click", SUBMIT)]), finished("Done.")],
      { screenChecks: new ScriptedScreenChecks() });
    await plain.go();
    expect(plain.desktop.acted).toHaveLength(2);
    expect(plain.desktop.crops).toHaveLength(1);
    expect(plain.store.handoffs(plain.run.id)).toEqual([]);
  });

  it("guards typing that presses Enter, without naming the text, and leaves other typing alone", async () => {
    const checks = new ScriptedScreenChecks({ irreversible: () => 0.88 });
    const h = setup([reply([toolUse("toolu_1", "type", { text: "Looks good to me\n" })]), finished("Posted.")], { screenChecks: checks });
    const ended = h.go();
    await approveWhenAsked(h, false);
    await ended;
    expect(h.desktop.acted).toEqual([]);
    expect(checks.asked).toEqual([{ question: "irreversible", action: "type 17 characters with Enter" }]);
    expect(JSON.stringify(h.store.handoffs(h.run.id))).not.toContain("Looks good");
    expect(results(h.messages.requests[1]!)[0]!.content).toEqual([{ type: "text", text: NOT_APPROVED }]);
    const plain = setup([reply([toolUse("toolu_1", "type", { text: "Looks good to me" })]), finished("Typed.")], { screenChecks: new ScriptedScreenChecks({ irreversible: () => 0.88 }) });
    await plain.go();
    expect(plain.desktop.acted).toEqual([{ kind: "type", text: "Looks good to me" }]);
    expect(plain.store.handoffs(plain.run.id)).toEqual([]);
  });

  it("runs nothing when the person takes the screen while the guard is still checking, and keeps the run going", async () => {
    for (const verdict of [0.03, 0.94]) {
      const checks = new ScriptedScreenChecks();
      let answer!: (yes: number) => void;
      let asked!: () => void;
      const asking = new Promise<void>((resolve) => { asked = resolve; });
      checks.irreversible = async () => { asked(); return new Promise<number>((resolve) => { answer = resolve; }); };
      const h = setup([reply([toolUse("toolu_1", "left_click", SUBMIT), toolUse("toolu_2", "type", { text: "x" })]), finished("Done.")], { screenChecks: checks });
      const ended = h.go();
      await asking;
      h.store.handOver(h.run.id, "person", "person", "");
      h.control.hold();
      answer(verdict);
      await Promise.race([h.control.waitingForPerson(), ended]);
      h.store.handBack(h.run.id);
      h.control.release();
      expect(await ended).toMatchObject({ state: "awaiting_done" });
      expect(h.desktop.acted).toEqual([]);
      expect(results(h.messages.requests[1]!).map((result) => result.content)).toEqual([[{ type: "text", text: TAKEN_OVER }], [{ type: "text", text: TAKEN_OVER }]]);
      expect(h.store.handoffs(h.run.id)).toEqual([expect.objectContaining({ cause: "person", askedBy: "person" })]);
    }
  });
});

describe("Secure Form in the loop", () => {
  const REQUEST = { title: "Sign in to the clinic portal", site: "portal.clinic.example",
    fields: [{ id: "email", label: "Email", type: "email" }, { id: "password", label: "Password", type: "password" }] };
  const SECRET = "fixture-secret-123";
  const formUse = (id: string) => ({ type: "tool_use", id, name: "request_secure_form", input: REQUEST });
  const fillUse = (id: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name: "fill_secure_field", input });

  it("asks the person for their details, waits, and types each value without Claude or the log seeing it", async () => {
    const forms = new RunSecureForms();
    let formId = "";
    const h = setup([
      reply([formUse("toolu_1")]),
      (request) => {
        formId = /form_id "(form_[a-f0-9]{16})"/.exec(String((results(request)[0]!.content as Array<{ text: string }>)[0]!.text))![1]!;
        return reply([fillUse("toolu_2", { form_id: formId, field_id: "email", x: 640, y: 300 }), fillUse("toolu_3", { form_id: formId, field_id: "password", x: 640, y: 360, submit: true })]);
      },
      finished("Signed in."),
    ], { forms, size: { width: 2560, height: 1600 } });
    const ended = h.go();
    for (let tries = 0; !forms.waiting() && tries < 100; tries++) await new Promise((resolve) => setImmediate(resolve));
    const waiting = forms.waiting()!;
    expect(h.formNotices).toEqual([{ runId: h.run.id, task: "Send the interpreter request for Tuesday", form: waiting }]);
    h.clock.advance(45_000);
    expect(forms.submit(waiting.formId, { email: "jacob@example.com", password: SECRET })).toEqual({ ok: true });
    h.control.answerForm(waiting.formId, "filled");
    expect((await ended).state).toBe("awaiting_done");
    expect(formId).toBe(waiting.formId);
    expect(h.desktop.commands).toHaveLength(2);
    expect(h.desktop.commands[0]).toContain(Buffer.from("jacob@example.com").toString("base64"));
    expect(h.desktop.commands[0]).toContain("xdotool mousemove --sync 948 444 click 1");
    expect(h.desktop.commands[1]).toContain("xdotool key --clearmodifiers Return");
    expect(results(h.messages.requests[2]!).map((result) => result.is_error ?? false)).toEqual([false, false]);
    const steps = h.store.steps(h.run.id);
    expect(steps[0]!.actions).toEqual([{ name: "request_secure_form", fields: 2, outcome: "filled" }]);
    expect(steps[0]!.actionMs).toBe(0);
    expect(steps[1]!.actions).toEqual([{ name: "fill_secure_field", outcome: "typed" }, { name: "fill_secure_field", outcome: "typed" }]);
    const everything = JSON.stringify([h.messages.requests, h.store.steps(h.run.id), h.store.run(h.run.id)]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(forms.view(formId)!.status).toBe("typed");
  });

  it("tells Claude when the person closes the form, and refuses a form that names no real site", async () => {
    const forms = new RunSecureForms();
    const h = setup([reply([formUse("toolu_1")]), reply([{ ...formUse("toolu_2"), input: { ...REQUEST, site: "github.io" } }]), finished("Stopped.")], { forms });
    const ended = h.go();
    for (let tries = 0; !forms.waiting() && tries < 100; tries++) await new Promise((resolve) => setImmediate(resolve));
    const waiting = forms.waiting()!;
    forms.cancel(waiting.formId);
    h.control.answerForm(waiting.formId, "cancelled");
    await ended;
    expect(results(h.messages.requests[1]!)[0]!.content).toEqual([{ type: "text", text: expect.stringContaining("closed the Secure Form") }]);
    expect(results(h.messages.requests[2]!)[0]).toMatchObject({ is_error: true, content: [{ type: "text", text: expect.stringContaining("shared by many sites") }] });
    expect(h.store.steps(h.run.id).map((step) => step.actions)).toEqual([[{ name: "request_secure_form", fields: 2, outcome: "cancelled" }], [{ name: "request_secure_form", outcome: "refused" }], []]);
  });

  it("does not type into a point outside the screenshot, or a value the person never gave", async () => {
    const forms = new RunSecureForms();
    const h = setup([reply([fillUse("toolu_1", { form_id: "form_0000000000000000", field_id: "email", x: 5000, y: 10 })]),
      reply([fillUse("toolu_2", { form_id: "form_0000000000000000", field_id: "email", x: 10, y: 10 })]), finished("Done.")], { forms });
    await h.go();
    expect(h.desktop.commands).toEqual([]);
    expect(results(h.messages.requests[1]!)[0]).toMatchObject({ is_error: true, content: [{ type: "text", text: "x and y must be whole pixel positions inside the 1280x800 screenshot." }] });
    expect(results(h.messages.requests[2]!)[0]).toMatchObject({ is_error: true, content: [{ type: "text", text: expect.stringContaining("no Secure Form with that form_id") }] });
  });
});

describe("the state check on the desktop as a third source of done", () => {
  const STATE: DoneRule = { pageCheck: null, stateCheck: { url: "https://portal.clinic.example/requests/", contains: "Request received" } };

  it("marks the run done by the state check when the desktop's browser shows the expected page", async () => {
    const h = setup([finished("Sent.")], { done: STATE });
    h.desktop.stateResult = { passed: true, detail: "The active tab is on https://portal.clinic.example/requests/42 and shows the expected text." };
    expect(await h.go()).toMatchObject({ state: "done", doneSource: "state_check", detail: h.desktop.stateResult.detail });
    expect(h.desktop.stateChecks).toEqual([STATE.stateCheck]);
  });

  it("tries the page check first, then the state check, and leaves the run to the person when neither passes", async () => {
    const check = fixedPageCheck(FAILS);
    const both: DoneRule = { pageCheck: WITH_PAGE.pageCheck, stateCheck: STATE.stateCheck };
    const h = setup([finished("Sent.")], { done: both, pageCheck: check });
    const ended = await h.go();
    expect(ended.state).toBe("awaiting_done");
    expect(ended.detail).toBe(`Claude says it is finished: Sent. The page check did not pass: ${FAILS.detail} The state check did not pass: ${h.desktop.stateResult.detail}`);
    expect(check.calls).toBe(1);
    expect(h.store.finish(h.run.id, { done: "person" }).doneSource).toBe("person");
  });

  it("settles an unknown submit by the state check, behind a sign-in where no page check can reach", async () => {
    const h = setup([reply([toolUse("toolu_1", "left_click", { coordinate: [900, 700] })])],
      { done: STATE, screenChecks: new ScriptedScreenChecks({ irreversible: () => 0.9, confirmed: () => 0.1 }) });
    h.desktop.stateResult = { passed: true, detail: "The active tab is on https://portal.clinic.example/requests/42 and shows the expected text." };
    const ended = h.go();
    await h.control.waitingForPerson();
    h.store.handBack(h.run.id);
    h.control.release(true);
    expect(await ended).toMatchObject({ state: "done", doneSource: "state_check" });
    expect(h.desktop.acted).toHaveLength(1);
  });
});

describe("how a run ends", () => {
  it("stops at once when the person taps Done mid-run", async () => {
    let h!: ReturnType<typeof setup>;
    h = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [1, 1] })]),
      () => {
        h.store.finish(h.run.id, { done: "person" });
        h.control.end();
        return reply([toolUse("toolu_2", "left_click", { coordinate: [2, 2] })]);
      },
    ]);
    expect(await h.go()).toMatchObject({ state: "done", doneSource: "person" });
    expect(h.desktop.acted).toHaveLength(1);
  });

  it("fails a run Claude declines", async () => {
    const { go } = setup([reply([], "refusal")]);
    expect(await go()).toMatchObject({ state: "failed", failure: "refusal" });
  });

  it("fails a run that reaches its step limit", async () => {
    const step = () => reply([toolUse(`toolu_${Math.random().toString(36).slice(2)}`, "wait", { duration: 1 })]);
    const { go, store, run } = setup([step(), step(), step()], { limits: { maxSteps: 2, maxWorkingMs: DEFAULT_LIMITS.maxWorkingMs } });
    expect(await go()).toMatchObject({ state: "failed", failure: "step_limit" });
    expect(store.steps(run.id)).toHaveLength(2);
  });

  it("fails a run that runs out of working time", async () => {
    const step = () => reply([toolUse(`toolu_${Math.random().toString(36).slice(2)}`, "wait", { duration: 120 })]);
    const { go } = setup([step(), step(), step()], { limits: { maxSteps: 100, maxWorkingMs: 200_000 } });
    expect(await go()).toMatchObject({ state: "failed", failure: "timed_out" });
  });

  it("fails a run when the API fails, and when another model answers", async () => {
    const broken = setup([() => { throw new Error("Claude's API answered 401 (authentication_error: invalid x-api-key)."); }]);
    expect(await broken.go()).toMatchObject({ state: "failed", failure: "error", detail: "Claude's API answered 401 (authentication_error: invalid x-api-key)." });
    const swapped = setup([reply([toolUse("toolu_1", "screenshot")], "tool_use", { model: "claude-sonnet-5-5" })]);
    expect(await swapped.go()).toMatchObject({ state: "failed", failure: "error", detail: "Claude's API answered with claude-sonnet-5-5, not the pinned claude-opus-5-5." });
    expect(swapped.desktop.frames).toHaveLength(1);
    expect(swapped.store.steps(swapped.run.id)).toEqual([expect.objectContaining({ step: 1, actions: [], ...FIXTURE_USAGE })]);
  });

  it("keeps the step it was on, with the actions that ran and its tokens, when the person stops the run mid-turn", async () => {
    let h!: ReturnType<typeof setup>;
    h = setup([
      reply([toolUse("toolu_1", "left_click", { coordinate: [1, 1] }), toolUse("toolu_2", "key", { text: "Return" }), toolUse("toolu_3", "left_click", { coordinate: [2, 2] })]),
    ], {
      fail: (action) => {
        if (action.kind === "key") { h.store.finish(h.run.id, { failed: "stopped" }); h.control.end(); }
        return null;
      },
    });
    expect(await h.go()).toMatchObject({ state: "failed", failure: "stopped" });
    expect(h.desktop.acted).toHaveLength(2);
    expect(h.store.steps(h.run.id)).toEqual([expect.objectContaining({
      step: 1, actions: [{ name: "left_click", coordinate: [1, 1] }, { name: "key", text: "Return" }], actionMs: 2 * ACTION_MS, ...FIXTURE_USAGE,
    })]);
  });

  it("accepts only the pinned model, or a dated name of that same model", () => {
    expect(sameModel("claude-opus-5-5", "claude-opus-5-5")).toBe(true);
    expect(sameModel("claude-opus-5-5", "claude-opus-5-5-20261015")).toBe(true);
    expect(sameModel("claude-opus-5", "claude-opus-5-5")).toBe(false);
    expect(sameModel("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false);
  });

  it("refuses to run a loop pinned to another model than the run", async () => {
    const { go, messages } = setup([finished("Done.")], { model: "claude-sonnet-5-5" });
    expect(await go()).toMatchObject({ state: "failed", failure: "error" });
    expect(messages.requests).toHaveLength(0);
  });
});
