import { describe, expect, it } from "vitest";

import { attentionKind } from "./dog-status";

describe("the one dot a dog carries", () => {
  it("asks for you before unread, and has no dot otherwise", () => {
    expect(attentionKind({ waiting: true, unread: true })).toBe("waiting");
    expect(attentionKind({ waiting: false, unread: true })).toBe("unread");
    expect(attentionKind({ waiting: false, unread: false })).toBeNull();
    expect(attentionKind({ waiting: false })).toBeNull();
  });
});
