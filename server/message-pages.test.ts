import { describe, expect, it } from "vitest";
import type { WireMessage } from "../shared/wire.ts";
import { briefStep, shownInChat, shownPageStart } from "./message-pages.ts";

let seq = 0;

function row(patch: Partial<WireMessage>): WireMessage {
  seq += 1;
  return { id: `m${seq}`, role: "bot", kind: "text", at: seq, ...patch };
}

function step(tool: Partial<NonNullable<WireMessage["tool"]>> = {}, extra: Partial<WireMessage> = {}): WireMessage {
  return row({ kind: "activity", tool: { name: "Bash", ok: true, input: "ls", output: "a\nb", ...tool }, ...extra });
}

const scout = { botId: "b1", name: "Scout", color: "#4b7bec" };

describe("message pages counted by what a chat shows", () => {
  it("counts replies, cards and status rows, never quiet tool steps or digests", () => {
    expect(shownInChat(row({ text: "hi" }))).toBe(true);
    expect(shownInChat(row({ text: "  " }))).toBe(false);
    expect(shownInChat(step())).toBe(false);
    expect(shownInChat(step({ ok: false }))).toBe(false);
    expect(shownInChat(step({ name: "error: The model is overloaded", ok: false }))).toBe(true);
    expect(shownInChat(step({ name: "notice: The home restarted" }))).toBe(true);
    expect(shownInChat(step({ ok: false }, { from: scout }))).toBe(true);
    expect(shownInChat(step({}, { from: scout }))).toBe(false);
    expect(shownInChat(step({ name: "Queued follow-up interrupted", ok: false }, { queueId: "q1" }))).toBe(true);
    expect(shownInChat(row({ kind: "digest" }))).toBe(false);
    expect(shownInChat(row({ kind: "options", card: { title: "Pick one", subtitle: "", options: ["a", "b"] } }))).toBe(true);
  });

  it("walks back until it holds the asked number of shown rows", () => {
    const rows = [
      row({ role: "user", text: "one" }), step(), step(), row({ text: "two" }),
      step(), step(), step(), row({ role: "user", text: "three" }), step(), row({ text: "four" }),
    ];
    expect(shownPageStart(rows, rows.length, 2)).toBe(7);
    expect(shownPageStart(rows, rows.length, 3)).toBe(3);
    expect(shownPageStart(rows, 7, 1)).toBe(3);
    expect(shownPageStart(rows, rows.length, 10)).toBe(0);
    expect(shownPageStart(rows, rows.length, 0)).toBe(rows.length);
  });

  it("never reaches back past the raw row cap", () => {
    const rows = [row({ text: "old" }), ...Array.from({ length: 20 }, () => step()), row({ text: "new" })];
    expect(shownPageStart(rows, rows.length, 2, 5)).toBe(rows.length - 5);
  });

  it("drops input and output only from the steps a chat hides", () => {
    expect(briefStep(step()).tool).toEqual({ name: "Bash", ok: true });
    const failedInRoom = step({ ok: false }, { from: scout });
    expect(briefStep(failedInRoom)).toBe(failedInRoom);
    const reply = row({ text: "done" });
    expect(briefStep(reply)).toBe(reply);
  });
});
