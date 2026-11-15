import { expect, it } from "vitest";
import type { RoomHandoff } from "../room-handoffs.ts";
import { openHandoffs } from "./open-handoffs.ts";

const node = (id: string, fields: Partial<RoomHandoff>): RoomHandoff => ({
  id, rootId: "turn", threadId: `${id}-chat`, botId: id, key: id, text: "", createdAt: 0, status: "queued",
  result: "", reported: false, executions: 0, approvalGranted: false, kind: "work", ...fields,
});

const tree = (leadStatus: RoomHandoff["status"] = "waiting") => [
  node("turn", { botId: "lead", threadId: "lead-chat", status: leadStatus }),
  node("pip", { parentId: "turn", createdAt: 1, status: "completed", reported: true, givenAt: 5, text: "Check the export\nwith the details below" }),
  node("quill", { parentId: "turn", createdAt: 2, status: "completed", reported: true, text: "Review the copy" }),
  node("rook", { parentId: "turn", createdAt: 3, status: "running", text: "Run the long suite" }),
  node("note", { parentId: "turn", createdAt: 4, status: "running", reply: "none", text: "FYI: release is live" }),
  node("done-note", { parentId: "turn", createdAt: 5, status: "completed", reported: true, reply: "none", text: "FYI: old news" }),
  node("other", { parentId: "elsewhere", createdAt: 6, status: "running", text: "Someone else's work" }),
];

it("lists what a dog handed off in a chat that is still out or whose result it has not been given", () => {
  expect(openHandoffs(tree(), "lead", "lead-chat")).toEqual([
    { id: "quill", to: "quill", what: "Review the copy", state: "completed", resultWaiting: true },
    { id: "rook", to: "rook", what: "Run the long suite", state: "running", resultWaiting: false },
    { id: "note", to: "note", what: "FYI: release is live", state: "running", resultWaiting: false },
  ]);
});

it("lists nothing for another chat of the same dog", () => {
  expect(openHandoffs(tree(), "lead", "other-chat")).toEqual([]);
});

it("does not call a result waiting once the dog that asked has finished", () => {
  expect(openHandoffs(tree("completed"), "lead", "lead-chat").map(open => [open.id, open.resultWaiting])).toEqual([["rook", false], ["note", false]]);
});

it("keeps the line short", () => {
  const long = [node("turn", { botId: "lead", threadId: "lead-chat", status: "waiting" }), node("pip", { parentId: "turn", text: `  \n${"x".repeat(400)}` })];
  const [open] = openHandoffs(long, "lead", "lead-chat");
  expect(open!.what).toHaveLength(140);
  expect(open!.what.endsWith("…")).toBe(true);
});
