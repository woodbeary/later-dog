import { describe, expect, it } from "vitest";
import type { MessagesRequest } from "./computer-use-anthropic.ts";
import type { DoneRule, PageCheck } from "./computer-use-done.ts";
import {
  ACTION_MS, FakeClock, FakeDesktop, finished, fixedPageCheck, FIXTURE_USAGE, memoryStore, MODEL_MS, reply, ScriptedMessages,
  takeoverUse, toolUse, WatchedControl, type ScriptedReply,
} from "./computer-use-fakes.ts";
import type { DesktopAction } from "./computer-use-loop.ts";
import { DEFAULT_LIMITS, HANDED_BACK_NOTE, NOT_EXECUTED, runComputerUse, sameModel, screenshotSha256, TAKEN_OVER, type LoopLimits } from "./computer-use-loop.ts";

const PERSON_ONLY: DoneRule = { pageCheck: null };
const WITH_PAGE: DoneRule = { pageCheck: { url: "https://clinic.example/requests/42", contains: "Request received" } };
const PASSES = { passed: true, detail: "HTTP 200; the page shows the expected text." };
const FAILS = { passed: false, detail: "HTTP 200; the expected text is not on the page." };

function setup(replies: ScriptedReply[], options: { done?: DoneRule; pageCheck?: PageCheck; size?: { width: number; height: number };
  fail?: (action: DesktopAction) => string | null; limits?: LoopLimits; model?: string } = {}) {
  const clock = new FakeClock();
  const store = memoryStore();
  const desktop = new FakeDesktop({ clock, size: options.size, fail: options.fail });
  const messages = new ScriptedMessages(replies, { clock, model: options.model });
  const control = new WatchedControl();
  const pageCheck = options.pageCheck ?? fixedPageCheck(PASSES);
  const run = store.start({ task: "Send the interpreter request for Tuesday", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: options.done ?? PERSON_ONLY });
  const go = () => runComputerUse(run.id, { store, desktop, messages, control, pageCheck, clock: clock.read,
    sleep: async (ms) => clock.advance(ms), limits: options.limits ?? DEFAULT_LIMITS });
  return { clock, store, desktop, messages, control, run, go };
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
        screenshotSha256: first, modelMs: MODEL_MS, actionMs: 2 * ACTION_MS, ...FIXTURE_USAGE },
      { step: 2, at: expect.any(String), actions: [{ name: "screenshot" }], screenshotSha256: first, modelMs: MODEL_MS, actionMs: ACTION_MS, ...FIXTURE_USAGE },
      { step: 3, at: expect.any(String), actions: [], screenshotSha256: second, modelMs: MODEL_MS, actionMs: 0, ...FIXTURE_USAGE },
    ]);
    expect(desktop.acted).toEqual([{ kind: "click", button: "left", count: 1, at: [640, 400], modifiers: [] }, { kind: "type", text: "Tuesday 10am" }]);
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
    expect(h.store.handoffs(h.run.id)).toEqual([expect.objectContaining({ cause: "sign-in", askedBy: "model", note: "Sign in to the clinic portal", returnedAt: null })]);
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
