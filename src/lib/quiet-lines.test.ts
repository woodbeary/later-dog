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

  it("never reorders or drops anything else", () => {
    const messages = [text("a"), comm("to"), comm("from"), text("b")];
    const items = fold(messages);
    expect(items.flatMap((item) => item.kind === "message" ? [item.message.id] : item.kind === "exchange" ? item.messages.map((m) => m.id) : [])).toEqual(messages.map((m) => m.id));
  });
});
