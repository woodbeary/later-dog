import { describe, expect, it } from "vitest";
import { threadsPastRetention } from "./native-run-retention.ts";

const day = 86_400_000;
const base = { archivedAt: null, unread: false, busy: false, openDirectHandoff: false };

describe("native run retention", () => {
  it("selects only idle conversations closed or archived beyond the window", () => {
    const now = 100 * day;
    expect(threadsPastRetention([
      { ...base, threadId: "old", closedAt: 10 * day },
      { ...base, threadId: "old-archived", closedAt: null, archivedAt: 20 * day },
      { ...base, threadId: "recent", closedAt: 95 * day },
      { ...base, threadId: "open", closedAt: null },
      { ...base, threadId: "unread", closedAt: 1, unread: true },
      { ...base, threadId: "busy", closedAt: 1, busy: true },
      { ...base, threadId: "handoff", closedAt: 1, openDirectHandoff: true },
    ], 30, now)).toEqual(["old", "old-archived"]);
  });
});
