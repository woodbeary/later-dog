import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@/lib/search-hit";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api }));

const { landOnSearchHit } = await import("./focus-message");

const hit = (over: Partial<SearchHit>): SearchHit => ({
  name: "Atlas", threadId: "atlas-main", messageId: "m1", role: "bot", kind: "text", at: 1,
  snippet: "the report is done", matchStart: 4, matchLength: 6, onActivePath: true, ...over,
});
const state = {
  bots: [{ id: "atlas", threadId: "atlas-main" }],
  groups: [{ id: "crew", threadId: "crew-main" }],
} as unknown as Parameters<typeof landOnSearchHit>[1];

beforeEach(() => api.mockReset());

describe("landOnSearchHit", () => {
  it("opens the dog and focuses the message in its one conversation", async () => {
    const dispatch = vi.fn();
    await landOnSearchHit(hit({ botId: "atlas" }), state, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "atlas" },
      { type: "focusMessage", threadId: "atlas-main", messageId: "m1", matchText: "report" },
    ]);
    expect(api).not.toHaveBeenCalled();
  });

  it("opens the dog without switching tasks for a hit in an old extra task", async () => {
    const dispatch = vi.fn();
    await landOnSearchHit(hit({ botId: "atlas", threadId: "atlas-old-extra" }), state, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "atlas" }]);
    expect(api).not.toHaveBeenCalled();
  });

  it("opens the group chat without switching tasks for a hit in an old extra group task", async () => {
    const dispatch = vi.fn();
    await landOnSearchHit(hit({ groupId: "crew", threadId: "crew-old-extra" }), state, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "crew" }]);
    expect(api).not.toHaveBeenCalled();
  });

  it("refuses a hit whose owner is gone", async () => {
    await expect(landOnSearchHit(hit({ botId: "gone" }), state, vi.fn())).rejects.toThrow("no longer available");
  });
});
