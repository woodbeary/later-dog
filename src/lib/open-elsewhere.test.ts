import { describe, expect, it } from "vitest";

import { ownerShowingElsewhere } from "./open-elsewhere";

const owners = [
  { id: "pepper", threadId: "pepper-main", tasks: [{ threadId: "pepper-old-run" }] },
  { id: "biscuit", threadId: "biscuit-main" },
  { id: "room", threadId: "room-main" },
];

describe("ownerShowingElsewhere", () => {
  it("finds another owner whose one conversation is the target", () => {
    expect(ownerShowingElsewhere(owners, "biscuit-main", "pepper")?.id).toBe("biscuit");
    expect(ownerShowingElsewhere(owners, "room-main", "pepper")?.id).toBe("room");
  });

  it("finds nothing for the conversation already in view", () => {
    expect(ownerShowingElsewhere(owners, "pepper-main", "pepper")).toBeUndefined();
  });

  it("finds nothing for an old extra task, which no longer opens on its own", () => {
    expect(ownerShowingElsewhere(owners, "pepper-old-run", "pepper")).toBeUndefined();
    expect(ownerShowingElsewhere(owners, "pepper-old-run", "room")).toBeUndefined();
  });

  it("finds nothing without a thread", () => {
    expect(ownerShowingElsewhere(owners, undefined, "pepper")).toBeUndefined();
  });
});
