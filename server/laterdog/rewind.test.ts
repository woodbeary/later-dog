import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { branchVersions, droppedAfter, leftInPlace, pathTo, rewindAction, versionOf } from "./rewind.ts";

const msg = (id: string, parentId: string | null, at: number, extra: Partial<Message> = {}): Message =>
  ({ id, parentId, at, role: "user", kind: "text", text: id, ...extra });
const bot = (id: string, parentId: string, at: number, extra: Partial<Message> = {}): Message =>
  msg(id, parentId, at, { role: "bot", ...extra });

const tree = [
  msg("ask-1", null, 1), bot("reply-1", "ask-1", 2),
  msg("ask-2", "reply-1", 3), bot("reply-2", "ask-2", 4),
  msg("ask-2b", "reply-1", 5), bot("reply-2b", "ask-2b", 6),
];

describe("rewind", () => {
  it("numbers each version of a rewound message in the order it was sent, for the branch being shown", () => {
    expect(branchVersions(tree, "reply-2b")).toEqual({
      "ask-2": { index: 1, count: 2, ids: ["ask-2", "ask-2b"] },
      "ask-2b": { index: 2, count: 2, ids: ["ask-2", "ask-2b"] },
    });
    expect(branchVersions(tree, "reply-1")).toEqual({});
    expect(versionOf(tree, tree[2]!)).toEqual({ index: 1, count: 2, ids: ["ask-2", "ask-2b"] });
    expect(versionOf(tree, tree[0]!)).toEqual({ index: 1, count: 1, ids: ["ask-1"] });
  });

  it("names what the dropped part changed that a rewind does not undo", () => {
    const path = [
      ...pathTo(tree, "reply-1"),
      msg("ask-x", "reply-1", 7),
      bot("ran", "ask-x", 8, { kind: "activity", tool: { name: "Bash", ok: true } }),
      bot("setup", "ran", 9, { kind: "activity", tool: { name: "connecting", setup: true } }),
      bot("reply-x", "setup", 10, { results: { files: [{ path: "a.txt", change: "created" }, { path: "a.txt", change: "edited" }], commands: 2 } }),
    ];
    const dropped = droppedAfter(path, { id: "ask-x" });
    expect(dropped.map((m) => m.id)).toEqual(["ask-x", "ran", "setup", "reply-x"]);
    expect(leftInPlace(dropped)).toEqual({ files: [{ path: "a.txt", change: "edited" }], moreFiles: 0, commands: 2, actions: 1 });
    expect(leftInPlace(droppedAfter(path, { id: "elsewhere" }))).toEqual({ files: [], moreFiles: 0, commands: 0, actions: 0 });
  });

  it("accepts only the three rewind actions", () => {
    expect(["hold", "resend", "send", "undo", 1].map(rewindAction)).toEqual(["hold", "resend", "send", null, null]);
  });
});
