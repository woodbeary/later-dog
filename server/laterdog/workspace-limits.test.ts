import { describe, expect, it } from "vitest";

import {
  SHARED_WORKSPACE_CREATIONS_PER_TURN,
  SHARED_WORKSPACE_DOG_LIMIT,
  dogLimitRefusal,
  turnCreationRefusal,
} from "./workspace-limits.ts";

describe("workspace limits", () => {
  it("never caps dogs in the owner's own workspace", () => {
    expect(dogLimitRefusal({ ownersWorkspace: true, dogs: SHARED_WORKSPACE_DOG_LIMIT })).toBeNull();
    expect(dogLimitRefusal({ ownersWorkspace: true, dogs: 5_000 })).toBeNull();
  });

  it("keeps the dog limit for shared and guest workspaces", () => {
    expect(dogLimitRefusal({ ownersWorkspace: false, dogs: SHARED_WORKSPACE_DOG_LIMIT - 1 })).toBeNull();
    expect(dogLimitRefusal({ ownersWorkspace: false, dogs: SHARED_WORKSPACE_DOG_LIMIT })).toContain(`${SHARED_WORKSPACE_DOG_LIMIT} dogs`);
  });

  it("never caps how many dogs or group chats the owner's dog makes in one turn", () => {
    expect(turnCreationRefusal({ ownersWorkspace: true, created: 40, kind: "dogs" })).toBeNull();
    expect(turnCreationRefusal({ ownersWorkspace: true, created: 40, kind: "group chats" })).toBeNull();
  });

  it("keeps the per-turn limit for guest turns", () => {
    expect(turnCreationRefusal({ ownersWorkspace: false, created: SHARED_WORKSPACE_CREATIONS_PER_TURN - 1, kind: "dogs" })).toBeNull();
    expect(turnCreationRefusal({ ownersWorkspace: false, created: SHARED_WORKSPACE_CREATIONS_PER_TURN, kind: "group chats" }))
      .toBe(`You can create at most ${SHARED_WORKSPACE_CREATIONS_PER_TURN} group chats in one turn here.`);
  });
});
