import { describe, expect, it } from "vitest";
import { createEngineSummaryWindows } from "./engine-summary-window.ts";

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

  it("refuses a second summary for the same compaction", () => {
    const windows = createEngineSummaryWindows();
    windows.sessionStarted("chat", "s1");
    windows.compacting("chat");
    expect(windows.accept("chat", "s1")).toBeNull();
    expect(windows.accept("chat", "s1")).toBe("already-received");
    windows.compacting("chat");
    expect(windows.accept("chat", "s1")).toBeNull();
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
