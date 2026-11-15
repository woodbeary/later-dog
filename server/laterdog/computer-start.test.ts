import { describe, expect, it } from "vitest";
import { cloudDidNotStart, createStartWatch, didNotStart, didNotStartText } from "./computer-start.ts";

describe("the start watch", () => {
  it("counts one start from the first time it is seen starting, across calls, until the budget is spent", () => {
    let now = 1_000;
    const watch = createStartWatch(() => 330_000, () => now);
    expect(watch.leftMs("cmp_a")).toBe(330_000);
    watch.starting("cmp_a");
    now += 240_000;
    watch.starting("cmp_a");
    expect(watch.leftMs("cmp_a")).toBe(90_000);
    expect(watch.spent("cmp_a")).toBe(false);
    now += 90_000;
    expect(watch.spent("cmp_a")).toBe(true);
  });

  it("starts counting again when the computer is woken from sleep or settles", () => {
    let now = 0;
    const watch = createStartWatch(() => 1_000, () => now);
    watch.starting("cmp_b");
    now = 5_000;
    expect(watch.spent("cmp_b")).toBe(true);
    watch.waking("cmp_b");
    expect(watch.leftMs("cmp_b")).toBe(1_000);
    now = 9_000;
    watch.settled("cmp_b");
    expect(watch.spent("cmp_b")).toBe(false);
    expect(watch.leftMs("cmp_b")).toBe(1_000);
  });
});

describe("a start another path gave up on", () => {
  it("counts as spent at once, and starts again once settled", () => {
    const watch = createStartWatch(() => 330_000, () => 50);
    watch.exhaust("cmp_c");
    expect(watch.spent("cmp_c")).toBe(true);
    watch.settled("cmp_c");
    expect(watch.spent("cmp_c")).toBe(false);
  });

  it("is told apart from other place failures by the cloud computer's did-not-start row", () => {
    expect(cloudDidNotStart({ place: "cloud", row: { state: "cc-no-start" } })).toBe(true);
    expect(cloudDidNotStart({ place: "cloud", row: { state: "cc-clearing" } })).toBe(false);
    expect(cloudDidNotStart({ place: "vm", row: { state: "cc-no-start" } })).toBe(false);
    expect(cloudDidNotStart(undefined)).toBe(false);
    expect(cloudDidNotStart(new Error("the cloud computer didn't start in time"))).toBe(false);
  });
});

describe("the answer when a computer did not start", () => {
  it("says it once, plainly, with the computer's own reason and what the dog can do instead", () => {
    expect(didNotStartText("The desktop did not become ready within 5 minutes.")).toBe(
      "Your cloud computer did not start (the desktop did not become ready within 5 minutes), so nothing was run, and waiting longer will not help. "
      + "Choose one instead: do light work in your folder here; call run_on_computer again with fresh: true to replace it with a new cloud computer "
      + "(your folders here stay, and are sent again; only what lived on the old computer alone, such as installed packages, is gone); "
      + "or tell the person what you could not do.",
    );
    expect(didNotStartText()).toMatch(/^Your cloud computer did not start, so nothing was run/);
    expect(didNotStart("  ")).toMatchObject({ code: "did_not_start", message: expect.stringMatching(/^Your cloud computer did not start, so/) });
  });
});
