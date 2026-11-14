import { describe, expect, it } from "vitest";
import { createEngineSummaryWindows, SUMMARY_GRACE_AFTER_COMPACTED_MS } from "./engine-summary-window.ts";

describe("when the home takes an engine's compaction summary", () => {
  it("takes one summary from the session that is compacting, while it compacts", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    expect(windows.accept("chat", "s1")).toBeNull();
  });

  it("refuses a summary when the chat's engine is not compacting", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    expect(windows.accept("chat", "s1")).toBe("not-compacting");
    expect(windows.accept("never-started", "s1")).toBe("not-compacting");
  });

  it("takes every post while the window is open, so the last one is the one kept", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    expect(windows.accept("chat", "s1")).toBeNull();
    expect(windows.accept("chat", "s1")).toBeNull();
    windows.compacting("chat");
    expect(windows.accept("chat", "s1")).toBeNull();
  });

  it("names the grace after the engine reports it compacted", () => {
    expect(SUMMARY_GRACE_AFTER_COMPACTED_MS).toBeGreaterThan(0);
    expect(SUMMARY_GRACE_AFTER_COMPACTED_MS).toBeLessThanOrEqual(30_000);
  });

  it("takes a post inside the grace after the engine reports it compacted", () => {
    let now = 1_000;
    const windows = createEngineSummaryWindows(() => now);
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    windows.compacted("chat");
    now += SUMMARY_GRACE_AFTER_COMPACTED_MS;
    expect(windows.accept("chat", "s1")).toBeNull();
  });

  it("refuses a post after the grace has run out, even though the turn is still running", () => {
    let now = 1_000;
    const windows = createEngineSummaryWindows(() => now);
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    windows.compacted("chat");
    now += SUMMARY_GRACE_AFTER_COMPACTED_MS + 1;
    expect(windows.accept("chat", "s1")).toBe("not-compacting");
    expect(windows.accept("chat", "s1")).toBe("not-compacting");
  });

  it("opens a new window for a second compaction in the same turn after the first one closed", () => {
    let now = 1_000;
    const windows = createEngineSummaryWindows(() => now);
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    windows.compacted("chat");
    now += SUMMARY_GRACE_AFTER_COMPACTED_MS + 1;
    expect(windows.accept("chat", "s1")).toBe("not-compacting");
    windows.compacting("chat");
    expect(windows.accept("chat", "s1")).toBeNull();
  });

  it("does nothing when a chat reports compacted without compacting", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    windows.compacted("chat");
    expect(windows.accept("chat", "s1")).toBe("not-compacting");
  });

  it("refuses a summary naming another session, or none", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    expect(windows.accept("chat", "s2")).toBe("other-session");
    expect(windows.accept("chat", undefined)).toBe("other-session");
    expect(windows.accept("chat", "s1")).toBeNull();
  });

  it("refuses a summary once the turn has ended", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    windows.turnEnded("chat");
    expect(windows.accept("chat", "s1")).toBe("not-compacting");
  });

  it("does not open a window on one chat for another", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("a", "s1");
    windows.sessionStarted("b", "s2");
    windows.compacting("a");
    expect(windows.accept("b", "s2")).toBe("not-compacting");
  });
});
