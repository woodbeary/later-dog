import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotEditorStore, type Message } from "@/state/store";
import { foldExchanges } from "@/lib/quiet-lines";
import { groupTranscript } from "@/lib/activity-runs";
import { ExchangeLine, RoutineCreatedLine } from "./QuietLines";

const helper = { id: "d2", name: "Study Helper", color: "purple" };
const boss = { id: "d1", name: "New Bot", color: "red" };
const store = (bots: unknown[]) => ({
  state: { bots, groups: [{ id: "g1", name: "New Bot ⇄ Study Helper", memberIds: ["d1", "d2"], dm: true, messages: [] }] },
  dispatch: () => {},
}) as unknown as Parameters<typeof BotEditorStore>[0]["value"];

const comm = (id: string, direction: "to" | "from", name = "Study Helper"): Message => ({
  id, role: "bot", kind: "activity", at: 1,
  tool: { name: direction === "to" ? `Messaged @${name}` : `Message from @${name}` },
  comm: { groupId: "g1", withBotId: "d2", withName: name, withColor: "purple", direction },
});

function exchange(messages: Message[]) {
  const item = foldExchanges(groupTranscript(messages))[0]!;
  if (item.kind !== "exchange") throw new Error("not an exchange");
  return item;
}

const folded = (message: Message[]) => {
  const item = foldExchanges(groupTranscript(message), { hasGroup: (id) => id === "g1" })[0]!;
  if (item.kind !== "exchange") throw new Error("not an exchange");
  return item;
};

const render = (bots: unknown[], messages: Message[]) =>
  renderToStaticMarkup(createElement(BotEditorStore, { value: store(bots), children: createElement(ExchangeLine, { item: exchange(messages) }) }));

describe("the quiet exchange line", () => {
  it("reads Messaged, the other dog's face, and its name, as one small grey button", () => {
    const html = render([boss, helper], [comm("a", "to")]);
    expect(html).toMatch(/Messaged<\/span>.*<svg.*Study Helper<\/span>/);
    expect(html).toContain("data-quiet-line");
    expect(html).toContain("text-ink-secondary");
    expect(html).toContain('aria-label="Read what New Bot and Study Helper said to each other"');
    expect(html).not.toContain("bg-panel");
  });

  it("counts repeats as 2 messages with", () => {
    const html = render([boss, helper], [comm("a", "to"), comm("b", "from")]);
    expect(html).toContain("2 messages with");
    expect(html).not.toContain(">Messaged<");
  });

  it("shows the dog's current name on an old message", () => {
    const html = render([boss, { ...helper, name: "Tutor", formerNames: ["Study Helper"] }], [comm("a", "to")]);
    expect(html).toContain("Tutor</span>");
    expect(html).not.toContain("Study Helper</span>");
    expect(html).toContain("New Bot and Tutor said");
  });

  it("falls back to the stored name and colour when the dog is gone", () => {
    const html = render([boss], [comm("a", "to")]);
    expect(html).toContain("Study Helper</span>");
  });
});

describe("the quiet line for a hand-off to a teammate's thread", () => {
  const sent: Message = {
    id: "s1", role: "bot", kind: "activity", at: 1, tool: { name: "Sent to Study Helper", ok: true },
    threadRef: { botId: "d2", threadId: "t2", title: "Colour question" },
  };
  it("reads Messaged and the current name, and says it opens the conversation", () => {
    const html = render([boss, { ...helper, name: "Tutor", formerNames: ["Study Helper"] }], [sent]);
    expect(html).toMatch(/Messaged<\/span>.*<svg.*Tutor<\/span>/);
    expect(html).toContain('aria-label="Open the conversation with Tutor"');
  });
});

describe("what a folded message leaves on the line", () => {
  it("shows the first line of the message and puts it in the title", () => {
    const asked: Message = { id: "q1", role: "user", kind: "text", at: 2, text: "can you check the deploy?\nmore", peerAsk: { botId: "d2", name: "Study Helper" } };
    const item = folded([comm("a", "from"), asked]);
    const html = renderToStaticMarkup(createElement(BotEditorStore, { value: store([boss, helper]), children: createElement(ExchangeLine, { item }) }));
    expect(html).toContain("data-exchange-preview");
    expect(html).toContain("can you check the deploy?");
    expect(html).not.toContain("more</span>");
    expect(html).toContain('title="Read what New Bot and Study Helper said to each other: can you check the deploy?"');
  });
});

describe("the quiet routine line", () => {
  it("reads Created routine, a timer, and the name", () => {
    const html = renderToStaticMarkup(createElement(RoutineCreatedLine, { name: "Weekday check", onOpen: () => {} }));
    expect(html).toMatch(/Created routine<\/span>.*<svg.*Weekday check<\/span>/);
    expect(html).toContain('aria-label="Open routine Weekday check"');
  });

  it("is plain text when the routine can no longer be opened", () => {
    const html = renderToStaticMarkup(createElement(RoutineCreatedLine, { name: "Weekday check" }));
    expect(html).not.toContain("<button");
    expect(html).toContain("Weekday check");
  });
});
