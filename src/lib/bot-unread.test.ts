import { describe, expect, it } from "vitest";
import { botShowsUnread } from "./bot-unread";

describe("botShowsUnread", () => {
  it("keeps the dog's own flag when it has no task list", () => {
    expect(botShowsUnread({ threadId: "s0", unread: true })).toBe(true);
    expect(botShowsUnread({ threadId: "s0" })).toBe(false);
    expect(botShowsUnread({ threadId: "s0", tasks: [], unread: true })).toBe(true);
  });

  it("reads only the dog's one conversation, so an old extra task never leaves a dot that cannot be cleared", () => {
    expect(botShowsUnread({ threadId: "main", unread: true, tasks: [
      { threadId: "main" },
      { threadId: "old-extra", unread: true },
    ] })).toBe(false);
    expect(botShowsUnread({ threadId: "main", tasks: [
      { threadId: "main", unread: true },
      { threadId: "old-extra" },
    ] })).toBe(true);
  });
});
