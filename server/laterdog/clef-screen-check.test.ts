import { describe, expect, it } from "vitest";

import { choiceAnswer, fakeDecider, yesAnswer, type FakeScript } from "./clef-fake-decider.ts";
import type { ClefLogRow } from "./clef-log.ts";
import {
  CAPTCHA_HINT, SECURE_FORM_HINT, createScreenCheck, describeAction, describeDecision, type ScreenShowing, type Shot,
} from "./clef-screen-check.ts";

const SHOWINGS: ScreenShowing[] = ["nothing", "login", "two_factor", "captcha", "error", "dialog"];
const jpeg = (label: string): Shot => ({ png: Buffer.from(`jpeg-${label}`).toString("base64"), format: "jpeg" });

interface Look {
  loading?: number;
  showing?: ScreenShowing;
  showingP?: number;
  changed?: number;
}

const looks = (...sequence: Look[]): FakeScript => (call, index) => {
  const look = sequence[Math.min(index, sequence.length - 1)] ?? {};
  return {
    answers: {
      loading: yesAnswer(look.loading ?? 0.05),
      showing: choiceAnswer(look.showing ?? "nothing", look.showingP ?? 0.95, SHOWINGS),
      ...(call.questions.changed ? { changed: yesAnswer(look.changed ?? 0.9) } : {}),
    },
  };
};

function harness(script: FakeScript, over: { enabled?: boolean } = {}) {
  const decider = fakeDecider(script);
  const rows: ClefLogRow[] = [];
  const waits: number[] = [];
  let clock = 0;
  const check = createScreenCheck({
    decider,
    enabled: () => over.enabled ?? true,
    record: (row) => { rows.push(row); },
    wait: async (ms) => { waits.push(ms); clock += ms; },
    now: () => clock,
  });
  return { check, decider, rows, waits };
}

describe("describeAction", () => {
  it("names what was done without repeating what was typed", () => {
    expect(describeAction("click", { x: 10, y: 20 })).toBe("a click at 10,20");
    expect(describeAction("type_text", { text: "hunter2" })).toBe("typing some text");
    expect(describeAction("open_url", { url: "https://example.com/path?token=abc" })).toBe("opening https://example.com");
    expect(describeAction("scroll", { x: 1, y: 2, direction: "down" })).toBe("scrolling down at 1,2");
  });
});

describe("the screen check after a screenshot", () => {
  it("returns the screenshot untouched, with no question asked, when it is off", async () => {
    const h = harness(looks({}), { enabled: false });
    const shot = jpeg("a");
    expect(await h.check.afterScreenshot({ boxId: "b", shot, capture: async () => shot })).toEqual({ shot, text: null, decision: null, waits: 0 });
    expect(h.decider.calls).toHaveLength(0);
  });

  it("says nothing needs attention for an ordinary loaded screen", async () => {
    const h = harness(looks({}));
    const result = await h.check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("z") });
    expect(result.text).toBe("Screen check: Nothing needs attention.");
    expect(result.waits).toBe(0);
    expect(h.rows).toEqual([expect.objectContaining({ kind: "screenCheck", action: "checked", waits: 0 })]);
    const call = h.decider.calls[0]!;
    expect(call.seam).toBe("screenCheck");
    expect(Object.keys(call.questions)).toEqual(["loading", "showing"]);
    expect(call.options.images).toEqual([`data:image/jpeg;base64,${jpeg("a").png}`]);
  });

  it("waits a second and looks again while the screen is loading", async () => {
    const h = harness(looks({ loading: 0.95 }, { loading: 0.9 }, { loading: 0.2 }));
    let taken = 0;
    const result = await h.check.afterScreenshot({ boxId: "b", shot: jpeg("0"), capture: async () => jpeg(String(++taken)) });
    expect(h.waits).toEqual([1_000, 1_000]);
    expect(result.waits).toBe(2);
    expect(result.shot).toEqual(jpeg("2"));
    expect(result.text).toBe("Screen check: Waited 2s for the screen to finish loading.");
  });

  it("stops waiting once about three seconds are used, however loading it looks", async () => {
    const stuck = harness(looks({ loading: 0.99 }));
    let again = 0;
    const last = await stuck.check.afterScreenshot({ boxId: "b", shot: jpeg("0"), capture: async () => jpeg(String(++again)) });
    expect(stuck.waits).toEqual([1_000, 1_000]);
    expect(stuck.decider.calls).toHaveLength(3);
    expect(last.shot).toEqual(jpeg("2"));
    expect(last.text).toContain("still looked like it was loading after waiting 2s");
  });

  it("gives back the plain screenshot at the hard deadline when a look hangs", async () => {
    const decider = fakeDecider(looks({ loading: 0.99 }));
    const check = createScreenCheck({ decider, enabled: () => true, record: () => undefined, wait: async () => undefined, totalMs: 150, loadingWaitMs: 5, askMinMs: 5 });
    const started = Date.now();
    const shot = jpeg("0");
    const result = await check.afterScreenshot({ boxId: "b", shot, capture: () => new Promise<Shot>(() => undefined) });
    expect(result).toMatchObject({ shot, text: null, decision: null });
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("gives the whole check no more than the total even when the decider is slow", async () => {
    const decider = fakeDecider(() => ({ hang: true }));
    const check = createScreenCheck({ decider, enabled: () => true, record: () => undefined, totalMs: 200 });
    const started = Date.now();
    const result = await check.afterScreenshot({ boxId: "b", shot: jpeg("0"), capture: async () => jpeg("1") });
    expect(result.text).toBeNull();
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("remembers nothing when off and forgets a box on request", async () => {
    const off = harness(looks({}), { enabled: false });
    off.check.noteAction("b", "click", { x: 1, y: 1 });
    await off.check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") });
    const h = harness(looks({}));
    await h.check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") });
    h.check.forgetBox("b");
    h.check.noteAction("b", "click", { x: 1, y: 1 });
    await h.check.afterScreenshot({ boxId: "b", shot: jpeg("b"), capture: async () => jpeg("b") });
    expect(Object.keys(h.decider.calls[1]!.questions)).toEqual(["loading", "showing"]);
  });

  it("points the model at the secure form when a login or code prompt shows", async () => {
    for (const showing of ["login", "two_factor"] as const) {
      const h = harness(looks({ showing }));
      const result = await h.check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") });
      expect(result.text).toContain(SECURE_FORM_HINT);
      expect(SECURE_FORM_HINT).toContain("request_secure_form");
    }
  });

  it("tells the model to hand a captcha to the person and to read errors and dialogs", async () => {
    expect((await harness(looks({ showing: "captcha" })).check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") })).text).toContain(CAPTCHA_HINT);
    expect((await harness(looks({ showing: "error" })).check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") })).text).toContain("An error is showing");
    expect((await harness(looks({ showing: "dialog" })).check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") })).text).toContain("A dialog is showing");
  });

  it("stays quiet about a blocker it is not sure of", async () => {
    const h = harness(looks({ showing: "login", showingP: 0.5 }));
    expect((await h.check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("a") })).text).toBe("Screen check: Nothing needs attention.");
  });

  it("compares with the last screenshot after an action, and says when nothing changed", async () => {
    const h = harness(looks({}, { changed: 0.1 }, { changed: 0.95 }));
    await h.check.afterScreenshot({ boxId: "b", shot: jpeg("before"), capture: async () => jpeg("x") });
    h.check.noteAction("b", "click", { x: 5, y: 6 });
    const unchanged = await h.check.afterScreenshot({ boxId: "b", shot: jpeg("after"), capture: async () => jpeg("x") });
    expect(unchanged.text).toBe("Screen check: The screen did not seem to change after a click at 5,6; it may not have worked.");
    const second = h.decider.calls[1]!;
    expect(Object.keys(second.questions)).toEqual(["loading", "showing", "changed"]);
    expect(second.options.images).toEqual([`data:image/jpeg;base64,${jpeg("before").png}`, `data:image/jpeg;base64,${jpeg("after").png}`]);
    h.check.noteAction("b", "key_press", { key: "Return" });
    const changed = await h.check.afterScreenshot({ boxId: "b", shot: jpeg("third"), capture: async () => jpeg("x") });
    expect(changed.text).toBe("Screen check: The screen changed as intended.");
    const quiet = await h.check.afterScreenshot({ boxId: "b", shot: jpeg("fourth"), capture: async () => jpeg("x") });
    expect(Object.keys(h.decider.calls[3]!.questions)).toEqual(["loading", "showing"]);
    expect(quiet.text).toBe("Screen check: Nothing needs attention.");
  });

  it("keeps each computer's last screen to itself", async () => {
    const h = harness(looks({}));
    await h.check.afterScreenshot({ boxId: "one", shot: jpeg("one"), capture: async () => jpeg("x") });
    h.check.noteAction("two", "click", { x: 1, y: 1 });
    await h.check.afterScreenshot({ boxId: "two", shot: jpeg("two"), capture: async () => jpeg("x") });
    expect(Object.keys(h.decider.calls[1]!.questions)).toEqual(["loading", "showing"]);
  });

  it("returns the plain screenshot when the decider fails, is slow, or the image cannot be sent", async () => {
    for (const script of [(() => ({ fail: "unreachable" })) as FakeScript, (() => ({ hang: true })) as FakeScript]) {
      const decider = fakeDecider(script);
      const check = createScreenCheck({ decider, enabled: () => true, record: () => undefined, budgetMs: 60 });
      const shot = jpeg("a");
      expect(await check.afterScreenshot({ boxId: "b", shot, capture: async () => shot })).toEqual({ shot, text: null, decision: null, waits: 0 });
    }
    const h = harness(looks({}));
    const big: Shot = { png: Buffer.alloc(200_000, 3).toString("base64"), format: "jpeg" };
    const result = await h.check.afterScreenshot({ boxId: "b", shot: big, capture: async () => big });
    expect(result).toMatchObject({ text: null, decision: null });
    expect(h.decider.calls).toHaveLength(0);
    expect(h.rows[0]).toMatchObject({ action: "skipped", reason: "too_large" });
  });

  it("stops when the call is cancelled instead of swallowing it", async () => {
    const controller = new AbortController();
    const decider = fakeDecider(looks({ loading: 0.99 }));
    const check = createScreenCheck({ decider, enabled: () => true, record: () => undefined, wait: async () => { controller.abort(new Error("stopped")); } });
    await expect(check.afterScreenshot({ boxId: "b", shot: jpeg("a"), capture: async () => jpeg("b"), signal: controller.signal })).rejects.toThrow("stopped");
  });

  it("describes a decision on its own", () => {
    expect(describeDecision({ loading: 0.1, changed: null, showing: "nothing", showingP: 0.9 }, 0, undefined)).toBe("Screen check: Nothing needs attention.");
  });
});
