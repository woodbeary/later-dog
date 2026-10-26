import { describe, expect, it } from "vitest";
import { DOG_NAME_LIMIT, newChatRows, nextActive, rowKey } from "./new-chat";

const dogs = [{ id: "a", name: "Biscuit" }, { id: "b", name: "Churro" }, { id: "c", name: "Rocket", hidden: true }];
const keys = (rows: ReturnType<typeof newChatRows>) => rows.map((row) => (row.kind === "create-dog" ? `create:${row.name ?? ""}` : rowKey(row)));

describe("the To: picker behind the sidebar +", () => {
  it("leads with Create new dog and Create group chat, then every dog that isn't hidden", () => {
    expect(keys(newChatRows({ dogs, query: "", grouping: false, picked: [] }))).toEqual(["create:", "create-group", "a", "b"]);
  });

  it("filters by what is typed, finds a hidden dog by name, and offers a new name as a new dog", () => {
    expect(keys(newChatRows({ dogs, query: "ro", grouping: false, picked: [] }))).toEqual(["create:ro", "b", "c"]);
    expect(keys(newChatRows({ dogs, query: " Rex ", grouping: false, picked: [] }))).toEqual(["create:Rex"]);
    expect(keys(newChatRows({ dogs, query: "CHURRO", grouping: false, picked: [] }))).toEqual(["b"]);
  });

  it("keeps a typed name within the name limit", () => {
    expect(newChatRows({ dogs, query: "x".repeat(DOG_NAME_LIMIT + 5), grouping: false, picked: [] })[0]).toEqual({ kind: "create-dog", name: "x".repeat(DOG_NAME_LIMIT) });
  });

  it("lists only dogs while making a group chat, marking the ones picked", () => {
    expect(newChatRows({ dogs, query: "", grouping: true, picked: ["b"] })).toEqual([
      { kind: "dog", dog: dogs[0], picked: false },
      { kind: "dog", dog: dogs[1], picked: true },
    ]);
  });

  it("moves the highlighted row with the arrow keys and wraps at either end", () => {
    expect(nextActive(0, 4, 1)).toBe(1);
    expect(nextActive(3, 4, 1)).toBe(0);
    expect(nextActive(0, 4, -1)).toBe(3);
    expect(nextActive(2, 0, 1)).toBe(0);
  });
});
