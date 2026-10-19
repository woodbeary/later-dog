import { describe, expect, it } from "vitest";

import { groupChatsOf, groupChatsText } from "./group-chats.ts";

const group = (id: string, memberIds: string[], extra: { dm?: boolean; section?: string } = {}) =>
  ({ id, name: `Room ${id}`, memberIds, dm: extra.dm, section: extra.section });

describe("group chats a dog is in", () => {
  it("lists only the dog's own group chats in its own pack, never direct chats", () => {
    const groups = [
      group("a", ["dog", "peer"]),
      group("b", ["peer"]),
      group("c", ["dog"], { dm: true }),
      group("d", ["dog", "peer"], { section: "Other" }),
      group("e", ["dog"], { section: " " }),
    ];
    expect(groupChatsOf(groups, { id: "dog", section: undefined })).toEqual([
      { id: "a", name: "Room a" },
      { id: "e", name: "Room e" },
    ]);
    expect(groupChatsOf(groups, { id: "dog", section: "Other" })).toEqual([{ id: "d", name: "Room d" }]);
  });

  it("says nothing when there are none or the reply is malformed", () => {
    expect(groupChatsText(undefined)).toBe("");
    expect(groupChatsText([])).toBe("");
    expect(groupChatsText([{ id: 1, name: "x" }])).toBe("");
    expect(groupChatsText([{ id: "a", name: "Launch" }])).toBe("Group chats you are in:\n- Launch [id: a]\n\nUse one of these ids as room_id with manage_room, or as group_id with coordinate_bots to ask its members there.");
  });
});
