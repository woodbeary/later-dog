import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { groupTranscript } from "./activity-runs";
import { exchangeRow, exchangeWording, foldExchanges } from "./quiet-lines";

let n = 0;
const comm = (direction: "to" | "from" | undefined, withBotId = "d2", name = "Study Helper", groupId = "g1"): Message => ({
  id: `m${++n}`, role: "bot", kind: "activity", at: n * 1000,
  tool: { name: direction === "from" ? `Message from @${name}` : `Messaged @${name}` },
  comm: { groupId, withBotId, withName: name, withColor: "purple", ...(direction ? { direction } : {}) },
});
const sent = (botId: string, name: string, threadId = `t-${botId}`): Message => ({
  id: `m${++n}`, role: "bot", kind: "activity", at: n * 1000,
  tool: { name: `Sent to ${name}`, ok: true },
  threadRef: { botId, threadId, title: "Teammate work" },
});
const text = (body: string): Message => ({ id: `m${++n}`, role: "bot", kind: "text", at: n * 1000, text: body });
const tool = (name: string): Message => ({ id: `m${++n}`, role: "bot", kind: "activity", at: n * 1000, tool: { name, ok: true } });

const fold = (messages: Message[], showCalls = true) =>
  foldExchanges(groupTranscript(messages), (item) => item.kind !== "run" || showCalls);

describe("dog-to-dog lines", () => {
  it("reads a sent or received line from the structure, and from the words older messages used", () => {
    expect(exchangeRow(comm("to"))?.direction).toBe("to");
    expect(exchangeRow(comm("from"))?.direction).toBe("from");
    expect(exchangeRow(comm(undefined))?.direction).toBe("to");
    const legacyFrom = comm(undefined);
    legacyFrom.tool = { name: "Message from @Study Helper" };
    expect(exchangeRow(legacyFrom)?.direction).toBe("from");
  });

  it("does not treat a room post, a teammate result or a plain tool as a dog-to-dog line", () => {
    const post = comm(undefined);
    post.tool = { name: "Posted in Launch" };
    const result = comm(undefined);
    result.tool = { name: "Engineer finished" };
    expect(exchangeRow(post)).toBeNull();
    expect(exchangeRow(result)).toBeNull();
    expect(exchangeRow(tool("Bash"))).toBeNull();
  });

  it("treats a hand-off to a teammate's thread as a Messaged line that opens that thread", () => {
    const row = exchangeRow(sent("d5", "Engineer"));
    expect(row).toMatchObject({ direction: "to", withBotId: "d5", withName: "Engineer", target: { kind: "thread", botId: "d5", threadId: "t-d5" } });
    const room = sent("d5", "Engineer");
    room.tool = { name: "Sent to Engineer · Launch", ok: true };
    expect(exchangeRow(room)?.withName).toBe("Engineer");
  });

  it("collapses repeat hand-offs to the same teammate and keeps different teammates apart", () => {
    const items = fold([sent("d5", "Engineer"), sent("d5", "Engineer"), sent("d6", "Writer")]);
    expect(items.map((item) => item.kind)).toEqual(["exchange", "exchange"]);
    const first = items[0]!;
    expect(first.kind === "exchange" && exchangeWording(first)).toEqual({ key: "chat.exchange.messagesWith", count: 2 });
  });

  it("reads the chips a dog's hand-off really leaves: opened a thread, added to a thread", () => {
    const opened = sent("d5", "x");
    opened.tool = { name: "Opened thread #Colour question on Study Helper", ok: true };
    const added = sent("d5", "x");
    added.tool = { name: "Added to thread #Colour question on Study Helper", ok: true };
    expect(exchangeRow(opened)).toMatchObject({ withName: "Study Helper", direction: "to" });
    expect(exchangeRow(added)).toMatchObject({ withName: "Study Helper", direction: "to" });
    const items = fold([opened, added]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === "exchange" && exchangeWording(items[0]!)).toEqual({ key: "chat.exchange.messagesWith", count: 2 });
  });

  it("leaves a thread a dog opened on itself as the ordinary chip", () => {
    const own = sent("d1", "x");
    own.tool = { name: "Opened thread #Review PR 4", ok: true };
    expect(exchangeRow(own)).toBeNull();
  });

  it("does not call a teammate's result a sent message", () => {
    const result = sent("d5", "Engineer");
    result.tool = { name: "Engineer finished", ok: true, output: "done" };
    expect(exchangeRow(result)).toBeNull();
  });

  it("shows one quiet Messaged line for one message", () => {
    const items = fold([text("Setting up"), comm("to"), text("Done")]);
    expect(items.map((item) => item.kind)).toEqual(["message", "exchange", "message"]);
    const line = items[1]!;
    expect(line.kind === "exchange" && exchangeWording(line)).toEqual({ key: "chat.exchange.messaged", count: 1 });
  });

  it("shows Message from for a single received message", () => {
    const item = fold([comm("from")])[0]!;
    expect(item.kind === "exchange" && exchangeWording(item).key).toBe("chat.exchange.messageFrom");
  });

  it("collapses repeats with the same dog into one 2 messages with line", () => {
    const items = fold([comm("to"), comm("from")]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind === "exchange" && exchangeWording(item)).toEqual({ key: "chat.exchange.messagesWith", count: 2 });
    expect(item.kind === "exchange" && item.messages).toHaveLength(2);
  });

  it("does not merge lines across different dogs or across a spoken message", () => {
    expect(fold([comm("to", "d2"), comm("to", "d3", "Scout")]).map((item) => item.kind)).toEqual(["exchange", "exchange"]);
    expect(fold([comm("to"), text("Asked it"), comm("to")]).map((item) => item.kind)).toEqual(["exchange", "message", "exchange"]);
  });

  it("merges across hidden tool steps but not across ones that are shown", () => {
    const hidden = fold([comm("to"), tool("Bash"), tool("Read"), comm("to")], false);
    expect(hidden.filter((item) => item.kind === "exchange")).toHaveLength(1);
    const shown = fold([comm("to"), tool("Bash"), tool("Read"), comm("to")], true);
    expect(shown.filter((item) => item.kind === "exchange")).toHaveLength(2);
  });

  it("tucks the other dog's written message into the line instead of showing it as a bubble", () => {
    const asked: Message = { id: `m${++n}`, role: "user", kind: "text", at: n * 1000, text: "what color is the sky?", peerAsk: { botId: "d2", name: "Study Helper" } };
    const reply = text("Blue, most days.");
    const items = fold([comm("from"), asked, reply]);
    expect(items.map((item) => item.kind)).toEqual(["exchange", "message"]);
    const line = items[0]!;
    expect(line.kind === "exchange" && line.messages.map((m) => m.id)).toEqual([line.kind === "exchange" ? line.messages[0]!.id : "", asked.id]);
    expect(line.kind === "exchange" && exchangeWording(line)).toEqual({ key: "chat.exchange.messageFrom", count: 1 });
  });

  it("keeps a peer message that has no line before it, and one from a different dog", () => {
    const asked: Message = { id: `m${++n}`, role: "user", kind: "text", at: n * 1000, text: "hi", peerAsk: { botId: "d9", name: "Other" } };
    expect(fold([asked]).map((item) => item.kind)).toEqual(["message"]);
    expect(fold([comm("from", "d2"), asked]).map((item) => item.kind)).toEqual(["exchange", "message"]);
  });

  it("never reorders or drops anything else", () => {
    const messages = [text("a"), comm("to"), comm("from"), text("b")];
    const items = fold(messages);
    expect(items.flatMap((item) => item.kind === "message" ? [item.message.id] : item.kind === "exchange" ? item.messages.map((m) => m.id) : [])).toEqual(messages.map((m) => m.id));
  });
});
