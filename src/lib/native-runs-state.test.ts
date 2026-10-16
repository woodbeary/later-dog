// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRun } from "../../shared/native-runs";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
const { api } = await import("@/state/store");
const { nativeHistoryIncomplete, currentNativeRuns, forgetNativeRuns, loadNativeRuns, nativeReceiptAnchors, receiveNativeRun, useNativeRuns } = await import("./native-runs-state");

function run(overrides: Partial<NativeRun> = {}): NativeRun {
  return { id: "run", threadId: "thread", turnId: "turn", provider: "claudeAgent", revision: 1, startedAt: 100, endedAt: 200, state: "done", observation: "complete", actors: [], activityCount: 2, failureCount: 0, limitations: [], ...overrides };
}

afterEach(() => { forgetNativeRuns(); vi.clearAllMocks(); });

describe("native run state", () => {
  it("does not let an older history response overwrite a newer live frame", () => {
    receiveNativeRun(run({ revision: 3, state: "failed" }));
    receiveNativeRun(run({ revision: 2 }));
    expect(currentNativeRuns("thread")[0]).toMatchObject({ revision: 3, state: "failed" });
  });

  it("does not restore another workspace's pending history after a reset", async () => {
    let resolve!: (value: { runs: NativeRun[] }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = loadNativeRuns("thread");
    forgetNativeRuns();
    resolve({ runs: [run()] });
    await pending;
    expect(currentNativeRuns("thread")).toEqual([]);
  });

  it("coalesces loads and follows an opaque history cursor", async () => {
    vi.mocked(api).mockResolvedValueOnce({ runs: [run()], nextCursor: "older / cursor" }).mockResolvedValueOnce({ runs: [run({ id: "older", turnId: "old-turn", startedAt: 50 })] });
    await Promise.all([loadNativeRuns("thread"), loadNativeRuns("thread")]);
    expect(api).toHaveBeenCalledTimes(1);
    await loadNativeRuns("thread", { older: true });
    expect(vi.mocked(api).mock.calls[1]?.[0]).toContain("cursor=older+%2F+cursor");
    expect(currentNativeRuns("thread").map(row => row.id)).toEqual(["run", "older"]);
  });

  it("anchors one persistent receipt to the last bot answer of its exact turn", () => {
    const messages = [{ id: "user", turnId: "turn", role: "user", kind: "text" }, { id: "draft", turnId: "turn", role: "bot", kind: "text" }, { id: "final", turnId: "turn", role: "bot", kind: "text" }, { id: "later-tool", turnId: "turn", role: "bot", kind: "activity" }, { id: "next", turnId: "next", role: "bot", kind: "text" }];
    const anchors = nativeReceiptAnchors([run(), run({ id: "live", turnId: "next", observation: "live", endedAt: undefined })], messages);
    expect([...anchors.keys()]).toEqual(["final"]);
  });

  it("loads receipts beyond 500 runs when the visible conversation reaches older history", async () => {
    vi.mocked(api).mockImplementation(async path => {
      const page = Number(new URL(path, "http://fixture").searchParams.get("cursor") ?? "0");
      return { runs: Array.from({ length: 100 }, (_, index) => run({ id: `run-${page * 100 + index}`, turnId: `turn-${page * 100 + index}`, startedAt: 1_000 - page * 100 - index })), ...(page < 5 ? { nextCursor: String(page + 1) } : {}) };
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function History() { return createElement("span", null, useNativeRuns("thread", 0).length); }
    try {
      await act(async () => root.render(createElement(History)));
      expect(host.textContent).toBe("600");
      expect(currentNativeRuns("thread").at(-1)?.id).toBe("run-599");
      expect(api).toHaveBeenCalledTimes(6);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("keeps unavailable history explicit and clears it when changing workspace", async () => {
    vi.mocked(api).mockResolvedValueOnce({ runs: [], historyIncomplete: true });
    await loadNativeRuns("thread");
    expect(nativeHistoryIncomplete("thread")).toBe(true);
    forgetNativeRuns();
    expect(nativeHistoryIncomplete("thread")).toBe(false);
  });

  it("leaves legacy progress available without repeated loads when an older server has no run route", async () => {
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));
    await expect(loadNativeRuns("thread")).resolves.toBeUndefined();
    await loadNativeRuns("thread");
    expect(currentNativeRuns("thread")).toEqual([]);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
