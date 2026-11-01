import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock, FakeDesktop, finished, fixedPageCheck, memoryStore, reply, ScriptedMessages, takeoverUse, toolUse, WatchedControl } from "./computer-use-fakes.ts";
import { DEFAULT_LIMITS, runComputerUse } from "./computer-use-loop.ts";
import { hashedTrace } from "./computer-use-trace.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("the trace to share", () => {
  it("hashes what Claude wrote into later.dog's own tools, such as the step it asked the person for, and keeps the toolset's actions", async () => {
    const step = "Type the code texted to 555 0100 for jacob@example.com";
    const clock = new FakeClock();
    const store = memoryStore();
    const control = new WatchedControl();
    const messages = new ScriptedMessages([
      reply([toolUse("toolu_1", "left_click", { coordinate: [10, 20] }), takeoverUse("toolu_2", step, "sign-in")]),
      reply([{ type: "tool_use", id: "toolu_3", name: "send_email", input: { to: "jacob@example.com" } }]),
      finished("Done."),
    ], { clock });
    const run = store.start({ task: "Send the interpreter request for Tuesday", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: { pageCheck: null } });
    const ended = runComputerUse(run.id, { store, desktop: new FakeDesktop({ clock }), messages, control, pageCheck: fixedPageCheck({ passed: false, detail: "fixture" }),
      clock: clock.read, sleep: async (ms) => clock.advance(ms), limits: DEFAULT_LIMITS });
    await control.waitingForPerson();
    store.handBack(run.id);
    control.release();
    await ended;
    const trace = hashedTrace({ run: store.run(run.id), steps: store.steps(run.id), handoffs: store.handoffs(run.id) });
    const text = JSON.stringify(trace);
    expect(text).not.toContain("jacob@example.com");
    expect(text).not.toContain("555 0100");
    expect(trace.steps[0]!.actions).toEqual([
      { name: "left_click", coordinate: [10, 20] },
      { name: "request_takeover", reason: "sign-in", inputSha256: sha256(JSON.stringify({ step, reason: "sign-in" })) },
    ]);
    expect(trace.steps[1]!.actions).toEqual([{ name: "send_email", inputSha256: sha256(JSON.stringify({ to: "jacob@example.com" })) }]);
    expect(trace.handoffs).toEqual([expect.objectContaining({ cause: "sign-in", askedBy: "model", noteSha256: sha256(step) })]);
  });
});
