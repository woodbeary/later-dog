import { describe, expect, it } from "vitest";
import { START_RAN_OUT, carryingOnRow, cloudDidNotStart, createStartWatch, didNotStart, didNotStartText, replacedRow, replacedText, startRanOutOfTime } from "./computer-start.ts";

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

describe("one start attempt", () => {
  it("is cleared when the computer's start generation changes, and kept while it stays the same", () => {
    let now = 0;
    const watch = createStartWatch(() => 1_000, () => now);
    watch.starting("cmp_g", 3);
    now = 800;
    watch.starting("cmp_g", 3);
    expect(watch.leftMs("cmp_g")).toBe(200);
    watch.starting("cmp_g", 4);
    expect(watch.leftMs("cmp_g")).toBe(1_000);
    watch.exhaust("cmp_g");
    expect(watch.spent("cmp_g")).toBe(true);
    watch.starting("cmp_g", 5);
    expect(watch.spent("cmp_g")).toBe(false);
  });

  it("is used up only by a start that ran out of time, not by other start errors", () => {
    expect(startRanOutOfTime(new Error(START_RAN_OUT))).toBe(true);
    expect(startRanOutOfTime(new Error("the cloud computer's desktop link could not be created: 502"))).toBe(false);
    expect(startRanOutOfTime(new Error("the cloud computer could not be created or reached"))).toBe(false);
    expect(startRanOutOfTime(START_RAN_OUT)).toBe(false);
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
  it("says it once, plainly, with a plain sentence for each known reason and no internal words", () => {
    expect(didNotStartText("The desktop did not become ready within 5 minutes.")).toBe(
      "Your cloud computer did not start. It did not finish starting within 5 minutes. Nothing was run, and waiting longer will not help. "
      + "Choose one instead: do light work in your folder here; call run_on_computer again in a few minutes; or tell the person what you could not do.",
    );
    expect(didNotStartText("The desktop did not become ready within 5 minutes.", { fresh: true })).toBe(
      "Your cloud computer did not start. It did not finish starting within 5 minutes. Nothing was run, and waiting longer will not help. "
      + "Choose one instead: do light work in your folder here; call run_on_computer again with fresh: true to get a new cloud computer. "
      + "Your folders here stay and are sent again, but nothing that lived only on the old computer comes along: installed packages, browser sign-ins, "
      + "downloads and files never brought back here. The old computer is set aside for 7 days, not deleted; or tell the person what you could not do.",
    );
    expect(didNotStartText("The computer stopped while starting.", { failed: true })).toBe(
      "Your cloud computer did not start. It stopped while starting. Nothing was run, and waiting longer will not help. Choose one instead: "
      + "do light work in your folder here; or tell the person what you could not do, and that your cloud computer did not start, so they can reset it in Settings.",
    );
    expect(didNotStartText("The computer stopped while restoring its snapshot.")).toMatch(/^Your cloud computer did not start\. It stopped while bringing back its saved files\. /);
    expect(didNotStartText("The computer stopped while starting.")).toMatch(/^Your cloud computer did not start\. It stopped while starting\. /);
    expect(didNotStartText("The computer could not start: RPC to container-host-12 failed")).toMatch(/^Your cloud computer did not start\. The cloud could not start it\. /);
    expect(didNotStartText("The computer could not start: RPC to container-host-12 failed")).not.toMatch(/RPC|host-12/);
    expect(didNotStartText("something nobody planned for")).toMatch(/^Your cloud computer did not start\. The computer could not start\. Nothing was run/);
    expect(didNotStartText()).toMatch(/^Your cloud computer did not start\. The computer could not start\. Nothing was run/);
    expect(didNotStart("  ")).toMatchObject({ code: "did_not_start", message: expect.stringMatching(/^Your cloud computer did not start\. The computer could not start\./) });
  });
});

describe("what a dog and the person are told after a replace", () => {
  it("says the old computer was set aside, for how long, and that what lived only on it did not come along", () => {
    expect(replacedText(7)).toBe("Your old cloud computer did not start, so it was replaced with a new one. The old one is set aside for 7 days; nothing that lived only on it came along.");
    expect(replacedRow("Scout", 7)).toBe("Scout's cloud computer did not start, so it was replaced with a new one; the old one is set aside for 7 days.");
  });
});

describe("the row the person sees while the dog carries on", () => {
  it("says the computer didn't start and that the dog carries on, never to try again", () => {
    expect(carryingOnRow("Scout")).toBe("Scout's cloud computer didn't start; Scout is carrying on without it.");
    expect(carryingOnRow("Scout")).not.toMatch(/try again/i);
  });
});
