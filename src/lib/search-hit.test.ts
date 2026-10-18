import { describe, expect, it } from "vitest";
import { inOneConversation } from "./search-hit";

const owners = {
  bots: [{ id: "atlas", threadId: "atlas-main" }],
  groups: [{ id: "crew", threadId: "crew-main" }, { id: "dm", threadId: "dm-main", dm: true }],
};

describe("inOneConversation", () => {
  it("keeps hits from each dog's and group chat's one conversation", () => {
    expect(inOneConversation({ botId: "atlas", threadId: "atlas-main" }, owners)).toBe(true);
    expect(inOneConversation({ groupId: "crew", threadId: "crew-main" }, owners)).toBe(true);
  });

  it("drops hits from old extra tasks, dog-to-dog exchanges and owners that are gone", () => {
    expect(inOneConversation({ botId: "atlas", threadId: "atlas-old-extra" }, owners)).toBe(false);
    expect(inOneConversation({ groupId: "crew", threadId: "crew-old-extra" }, owners)).toBe(false);
    expect(inOneConversation({ groupId: "dm", threadId: "dm-main" }, owners)).toBe(false);
    expect(inOneConversation({ botId: "gone", threadId: "gone-main" }, owners)).toBe(false);
    expect(inOneConversation({ threadId: "orphan" }, owners)).toBe(false);
  });
});
