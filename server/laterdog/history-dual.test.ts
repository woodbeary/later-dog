import { expect, it } from "vitest";
import { compareHistoryTail } from "./history-client.ts";

it("compares bounded recent rows across byte-limited pages and detects missing rows and leaf drift", async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id }));
  const local = { messages: rows, activeLeafId: "leaf", hasMore: false };
  const get =
    (messages: unknown[], activeLeafId: string | null = local.activeLeafId) =>
    async (limit: number, after: string | null) => {
      const start = Number(after ?? 0),
        end = Math.min(start + limit, start + 3, messages.length),
        more = end < messages.length;
      return { messages: messages.slice(start, end), activeLeafId, hasMore: more, next: more ? String(end) : null };
    };
  const reverse = rows.toReversed();
  expect(await compareHistoryTail(local, 64, get(reverse))).toBe(true);
  expect(await compareHistoryTail(local, 64, get(reverse.slice(0, 64)))).toBe(false);
  expect(await compareHistoryTail(local, 64, get(reverse.filter((r) => r.id !== 55)))).toBe(false);
  expect(await compareHistoryTail(local, 64, get(reverse, "other"))).toBe(false);
  expect(await compareHistoryTail({ messages: [], activeLeafId: null }, 64, get([], null))).toBe(true);
});
