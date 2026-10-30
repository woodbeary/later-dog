import { describe, expect, it } from "vitest";

import { TurnToolkits, askedConnector, connectorAllowKey, connectorSendDecision, toolkitOf } from "./connector-ask.ts";

const never = () => false;

describe("toolkitOf", () => {
  it("takes the connector from a Composio slug, preferring the longest connected name", () => {
    expect(toolkitOf("GMAIL_SEND_EMAIL")).toBe("gmail");
    expect(toolkitOf("BLAND_AI_SEND_CALL", ["bland", "bland_ai"])).toBe("bland_ai");
    expect(toolkitOf("COMPOSIO_PROXY_EXECUTE")).toBeNull();
  });
});

describe("askedConnector", () => {
  it("names one connector only when every call uses it", () => {
    expect(askedConnector([{ slug: "GMAIL_SEND_EMAIL" }, { slug: "GMAIL_REPLY_TO_THREAD" }])).toBe("gmail");
    expect(askedConnector([{ slug: "GMAIL_SEND_EMAIL" }, { slug: "SLACK_SEND_MESSAGE" }])).toBeNull();
    expect(askedConnector([{ slug: "COMPOSIO_PROXY_EXECUTE" }])).toBeNull();
  });
});

describe("connectorSendDecision", () => {
  const gmail = [{ slug: "GMAIL_SEND_EMAIL" }];

  it("asks with the connector to remember, and sends once Always allow is kept for it", () => {
    expect(connectorSendDecision({ calls: gmail, connected: [], alwaysAllow: [], ownerSends: false, skipped: never, allowedThisTurn: never }))
      .toEqual({ kind: "ask", toolkit: "gmail" });
    expect(connectorSendDecision({ calls: gmail, connected: [], alwaysAllow: [connectorAllowKey("gmail")], ownerSends: false, skipped: never, allowedThisTurn: never }))
      .toEqual({ kind: "send", rule: "always-allow" });
    expect(connectorSendDecision({ calls: gmail, connected: [], alwaysAllow: [connectorAllowKey("slack")], ownerSends: false, skipped: never, allowedThisTurn: never }))
      .toEqual({ kind: "ask", toolkit: "gmail" });
  });

  it("asks for a batch across apps even if one of them is always allowed", () => {
    expect(connectorSendDecision({
      calls: [...gmail, { slug: "STRIPE_CREATE_REFUND" }], connected: [], alwaysAllow: [connectorAllowKey("gmail")], ownerSends: false, skipped: never, allowedThisTurn: never,
    })).toEqual({ kind: "ask", toolkit: null });
  });

  it("always asks for code it cannot read, even for the owner", () => {
    expect(connectorSendDecision({ calls: [{ slug: "COMPOSIO_PROXY_EXECUTE" }], connected: [], alwaysAllow: [], ownerSends: true, skipped: never, allowedThisTurn: never }))
      .toEqual({ kind: "ask", toolkit: null });
  });

  it("refuses a skipped connector without asking again", () => {
    expect(connectorSendDecision({ calls: gmail, connected: [], alwaysAllow: [connectorAllowKey("gmail")], ownerSends: false, skipped: (toolkit) => toolkit === "gmail", allowedThisTurn: (toolkit) => toolkit === "gmail" }))
      .toEqual({ kind: "skipped", toolkit: "gmail" });
  });

  it("sends without a second card once the person allowed that app earlier in the same turn", () => {
    const thisTurn = (toolkit: string) => toolkit === "gmail";
    expect(connectorSendDecision({ calls: gmail, connected: [], alwaysAllow: [], ownerSends: false, skipped: never, allowedThisTurn: thisTurn }))
      .toEqual({ kind: "send", rule: "this-turn" });
    expect(connectorSendDecision({ calls: [{ slug: "SLACK_SEND_MESSAGE" }], connected: [], alwaysAllow: [], ownerSends: false, skipped: never, allowedThisTurn: thisTurn }))
      .toEqual({ kind: "ask", toolkit: "slack" });
    expect(connectorSendDecision({ calls: [...gmail, { slug: "SLACK_SEND_MESSAGE" }], connected: [], alwaysAllow: [], ownerSends: false, skipped: never, allowedThisTurn: thisTurn }))
      .toEqual({ kind: "ask", toolkit: null });
    expect(connectorSendDecision({ calls: [{ slug: "COMPOSIO_PROXY_EXECUTE" }], connected: [], alwaysAllow: [], ownerSends: false, skipped: never, allowedThisTurn: () => true }))
      .toEqual({ kind: "ask", toolkit: null });
  });

  it("sends for the owner without a card", () => {
    expect(connectorSendDecision({ calls: gmail, connected: [], alwaysAllow: [], ownerSends: true, skipped: never, allowedThisTurn: never }))
      .toEqual({ kind: "send", rule: "owner-auto" });
  });
});

describe("TurnToolkits", () => {
  it("keeps a turn's choice until the next turn in that conversation", () => {
    const choices = new TurnToolkits();
    choices.add("thread-a", "turn-1", ["gmail"]);
    expect(choices.has("thread-a", "turn-1", "gmail")).toBe(true);
    expect(choices.has("thread-a", "turn-1", "slack")).toBe(false);
    expect(choices.has("thread-b", "turn-1", "gmail")).toBe(false);
    expect(choices.has("thread-a", "turn-2", "gmail")).toBe(false);
    expect(choices.has("thread-a", "turn-1", "gmail")).toBe(false);
  });
});
