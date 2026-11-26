import { expect, it, vi } from "vitest";
import { overviewHistory } from "./history-snapshot-cache.ts";
import { prepareHistoryTails } from "./history-snapshots.ts";
const io = vi.hoisted(() => ({ reads: 0, rows: [] as { id: string }[] }));
vi.mock("./history-client.ts", () => ({
  isRemoteHistory: () => true,
  historyManyAsync: async (ids: string[], op: { limit: number }) => {
    io.reads++;
    return ids.map((threadId) => ({
      threadId,
      result: {
        messages: io.rows.slice(0, Math.min(op.limit, 2)),
        hasMore: io.rows.length > Math.min(op.limit, 2),
        next: op.limit > 0 ? "2" : null,
        activeLeafId: io.rows[0]?.id ?? null,
      },
    }));
  },
  historyExecuteAsync: async (_thread: string, op: { after: string; limit: number }) => {
    io.reads++;
    const start = Number(op.after),
      end = Math.min(io.rows.length, start + op.limit);
    return {
      messages: io.rows.slice(start, end),
      hasMore: end < io.rows.length,
      next: end < io.rows.length ? String(end) : null,
      activeLeafId: io.rows[0].id,
    };
  },
}));
it("batches cold overview pages, shares the lighter summaries and discards a prepared view when its conversation changes", async () => {
  io.rows = [{ id: "4" }, { id: "3" }, { id: "2" }, { id: "1" }];
  const cold = await prepareHistoryTails(["bot", "room", "bot"], 3);
  expect(cold("bot")).toMatchObject({
    messages: [{ id: "2" }, { id: "3" }, { id: "4" }],
    activeLeafId: "4",
    hasMore: true,
  });
  expect(io.reads).toBe(3);
  const zero = await prepareHistoryTails(["bot", "room"], 0);
  expect(zero("bot")).toEqual({ messages: [], hasMore: true, activeLeafId: "4" });
  expect(io.reads).toBe(3);
  overviewHistory.invalidate("bot");
  expect(cold("bot")).toBeUndefined();
  expect(zero("room")?.activeLeafId).toBe("4");
  await prepareHistoryTails(["bot", "room"], 0);
  expect(io.reads).toBe(4);
});
