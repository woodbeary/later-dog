import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { groupTranscript } from "./activity-runs";
import { exchangeGist, foldExchanges, quietTranscriptItemShown, shownToPerson, singleExchange, type ExchangeItem } from "./quiet-lines";

const comm = { groupId: "g", threadId: "x", withBotId: "clover", withName: "Clover", withColor: "yellow" as const, direction: "from" as const };
const at = (n: number) => 1_000 + n;
const fromClover: Message = { id: "c1", role: "bot", kind: "activity", at: at(1), turnId: "t1", tool: { name: "Message from Clover", ok: true }, comm };
const request: Message = { id: "r1", role: "bot", kind: "text", at: at(2), turnId: "t1", text: "@Patch From Clover: fix the usage ring\nmore", roomRequest: { id: "q1", phase: "request" }, from: { botId: "clover", name: "Clover", color: "yellow" } };
const reply: Message = { id: "p1", role: "bot", kind: "text", at: at(3), turnId: "t1", text: "Done, shipped.", roomRequest: { id: "q1", phase: "reply" } };
const jacob: Message = { id: "u1", role: "user", kind: "text", at: at(4), text: "thanks" };
const answer: Message = { id: "b1", role: "bot", kind: "text", at: at(5), turnId: "t2", text: "You're welcome." };
const sent: Message = { id: "s1", role: "bot", kind: "activity", at: at(6), turnId: "t3", tool: { name: "Sent to Patch", ok: true }, comm: { groupId: "g2", threadId: "y", withBotId: "patch", withName: "Patch", withColor: "blue", direction: "to" } };
const report: Message = { id: "s2", role: "bot", kind: "activity", at: at(7), turnId: "t4", roomRequest: { id: "q2", phase: "result" }, tool: { name: "Patch finished", ok: true, output: "Released 0.9.1 with every detail" }, comm: { ...sent.comm!, direction: "from" } };
const asks: Message = { id: "k1", role: "bot", kind: "options", at: at(3), turnId: "t1", card: { title: "Ship it?", subtitle: "", options: ["Yes"] } };

describe("dog-to-dog traffic in a dog's chat", () => {
  it("keeps the request and the dog's reply to the other dog out of the chat, and keeps Jacob's messages and replies to him", () => {
    expect([fromClover, request, reply, jacob, answer].filter(shownToPerson).map((message) => message.id)).toEqual(["c1", "u1", "b1"]);
  });

  it("shows each exchange as one row, never the full text", () => {
    const items = foldExchanges(groupTranscript([fromClover, request, reply, jacob, answer, sent, report].filter(shownToPerson)), {
      renders: (item) => quietTranscriptItemShown(item, false),
      hasGroup: () => true,
    });
    const exchanges = items.filter((item): item is ExchangeItem => item.kind === "exchange");
    expect(exchanges.map((item) => item.messages.map((message) => message.id))).toEqual([["c1"], ["s1"], ["s2"]]);
    expect(items.some((item) => item.kind === "message" && item.message.text?.includes("usage ring"))).toBe(false);
  });

  it("gives the row a one-line gist and a state", () => {
    const fold = singleExchange(fromClover)!;
    expect(exchangeGist(fold, [fromClover, request], true)).toEqual({ gist: "From Clover: fix the usage ring more", state: "Working" });
    expect(exchangeGist(fold, [fromClover, request], false).state).toBe("Queued");
    expect(exchangeGist(fold, [fromClover, request, asks], true).state).toBe("Needs you");
    expect(exchangeGist(fold, [fromClover, request, reply], false).state).toBe("Done");
    const long = { ...request, text: `@Patch ${"word ".repeat(40)}` };
    expect(exchangeGist(fold, [fromClover, long], false).gist).toHaveLength(90);
  });

  it("marks a message to another dog done once its report comes back", () => {
    const fold = singleExchange(sent)!;
    expect(exchangeGist(fold, [sent], true).state).toBe("Working");
    expect(exchangeGist(fold, [sent, report], false).state).toBe("Done");
  });

  it("hides the exchange text in the dog's chat and gives the rows the whole thread for the gist", () => {
    const chat = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8");
    expect(chat).toContain("thread.filter(shownToPerson)");
    expect(chat).toContain("<ExchangeThreadContext.Provider value={exchangeThread}>");
    const line = readFileSync(new URL("../components/QuietLines.tsx", import.meta.url), "utf8");
    expect(line).toContain("exchangeGist(item, exchangeThread.thread, exchangeThread.working)");
    expect(line).toContain("openExchange(target.groupId)");
  });
});
