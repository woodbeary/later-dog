import { describe, expect, it } from "vitest";

import { fakeDecider, yesAnswer, type FakeScript } from "./clef-fake-decider.ts";
import type { ClefLogRow } from "./clef-log.ts";
import { createScreenshotFilter, type Frame } from "./clef-screenshot-filter.ts";

const frame = (label: string): Frame => ({ png: Buffer.from(`image-${label}`).toString("base64"), mime: "image/jpeg" });

const asks = (worth: number, secret: number): FakeScript => () => ({ answers: { worth: yesAnswer(worth), secret: yesAnswer(secret) } });

function harness(script: FakeScript, enabled = true) {
  const decider = fakeDecider(script);
  const rows: ClefLogRow[] = [];
  const filter = createScreenshotFilter({ decider, enabled: () => enabled, record: (row) => { rows.push(row); }, budgetMs: 80 });
  return { filter, decider, rows };
}

const input = (label: string, over: Partial<{ task: string; reply: string }> = {}) => ({
  threadId: "t1", frame: frame(label), task: "Check the invoice page.", reply: "The invoice page loaded.", ...over,
});

describe("the screenshot filter", () => {
  it("posts a screen that is worth showing and has no secret", async () => {
    const h = harness(asks(0.9, 0.02));
    expect(await h.filter.shouldPost(input("a"))).toEqual({ post: true, reason: "worth_showing" });
    expect(h.rows[0]).toMatchObject({ kind: "screenshotFilter", action: "posted", worth: 0.9, secret: 0.02 });
    const call = h.decider.calls[0]!;
    expect(call.seam).toBe("screenshotFilter");
    expect(Object.keys(call.questions)).toEqual(["worth", "secret"]);
    expect(call.options.images).toEqual([`data:image/jpeg;base64,${frame("a").png}`]);
  });

  it("holds back a screen that is not worth showing", async () => {
    const h = harness(asks(0.2, 0.01));
    expect(await h.filter.shouldPost(input("a"))).toEqual({ post: false, reason: "not_worth_showing" });
    expect(h.rows[0]).toMatchObject({ action: "withheld", reason: "not_worth_showing" });
  });

  it("never posts a screen that likely shows a secret, however worth showing", async () => {
    const h = harness(asks(0.99, 0.31));
    expect(await h.filter.shouldPost(input("a"))).toEqual({ post: false, reason: "secret_likely" });
    expect(h.rows[0]).toMatchObject({ action: "withheld", reason: "secret_likely" });
  });

  it("compares with the screen it last posted", async () => {
    const h = harness(asks(0.9, 0.01));
    await h.filter.shouldPost(input("first"));
    await h.filter.shouldPost(input("second"));
    expect(h.decider.calls[1]!.options.images).toEqual([`data:image/jpeg;base64,${frame("first").png}`, `data:image/jpeg;base64,${frame("second").png}`]);
    expect((h.decider.calls[1]!.state as { earlier_image_shown: boolean }).earlier_image_shown).toBe(true);
  });

  it("keeps the screen it withheld out of the comparison", async () => {
    let worth = 0.9;
    const h = harness(() => ({ answers: { worth: yesAnswer(worth), secret: yesAnswer(0.01) } }));
    await h.filter.shouldPost(input("kept"));
    worth = 0.1;
    await h.filter.shouldPost(input("dropped"));
    worth = 0.9;
    await h.filter.shouldPost(input("next"));
    expect(h.decider.calls[2]!.options.images![0]).toBe(`data:image/jpeg;base64,${frame("kept").png}`);
  });

  it("posts as before when the filter is off or the decider cannot answer", async () => {
    const off = harness(asks(0, 1), false);
    expect(await off.filter.shouldPost(input("a"))).toEqual({ post: true, reason: "off" });
    expect(off.decider.calls).toHaveLength(0);
    const down = harness(() => ({ fail: "unreachable" }));
    expect(await down.filter.shouldPost(input("a"))).toEqual({ post: true, reason: "decider_unavailable" });
    const slow = harness(() => ({ hang: true }));
    expect(await slow.filter.shouldPost(input("a"))).toEqual({ post: true, reason: "decider_unavailable" });
    const bad = harness(asks(0.9, 0.01));
    expect(await bad.filter.shouldPost({ ...input("a"), frame: { png: "not base64!", mime: "image/jpeg" } })).toEqual({ post: true, reason: "decider_unavailable" });
  });

  it("does not send secrets from the task or reply, and keeps them short", async () => {
    const h = harness(asks(0.9, 0.01));
    await h.filter.shouldPost(input("a", { reply: `token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(5_000)}` }));
    const state = h.decider.calls[0]!.state as { last_reply: string };
    expect(state.last_reply).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(state.last_reply.length).toBeLessThanOrEqual(1_200);
  });
});
