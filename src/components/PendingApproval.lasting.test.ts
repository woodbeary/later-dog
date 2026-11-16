import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import type { LastingOffer } from "../../shared/lasting-allows";

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, dispatch: vi.fn() }));
vi.mock("@/state/store-selectors", async (original) => ({ ...await original<typeof import("@/state/store-selectors")>(), ...await (await import("@/testing/store-selectors")).selectorsOverMockedStore() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

import { pendingApprovals, PendingApprovalActions } from "./PendingApproval";

const bot = { id: "bot-1", name: "Wren" } as Bot;
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function view(lasting: LastingOffer | undefined, extra: Partial<NonNullable<Message["card"]>> = {}) {
  const message: Message = {
    id: "approval-1", at: 1, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: "weather in oslo", options: ["Allow", "Deny"], tool: "WebSearch", requestId: "request-1", lasting, ...extra },
  };
  const tree = PendingApprovalActions({ pending: pendingApprovals([message])[0]!, bot, threadId: "thread-1" });
  return { html: renderToStaticMarkup(tree), buttons: nodes(tree).filter((node) => node.type === "button") };
}
const labels = (buttons: Node[]) => buttons.map((button) => button.props.children);

beforeEach(() => { fixture.admin = true; fixture.dispatch.mockReset(); });

describe("a card that offers a lasting Always", () => {
  it("shows Allow once, Don't allow and Always allow, and says what it covers", () => {
    const result = view({ offered: true, reach: "server words" });
    expect(labels(result.buttons)).toEqual(["Allow once", "Don't allow", "Always allow"]);
    expect(result.html).toContain("Always allow lets Wren search for exactly this again without asking, in any of its chats.");
    expect(result.html).not.toContain("Allow for this chat");
  });

  it("grants for the dog and answers the card as always", () => {
    view({ offered: true, reach: "x" }).buttons.find((button) => button.props.children === "Always allow")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "decideRequest", threadId: "thread-1", requestId: "request-1", behavior: "allow",
      lastingGrant: { botId: "bot-1" }, alwaysAllow: undefined, always: undefined, scope: "always",
    }));
  });

  it("keeps Allow once from saving anything", () => {
    view({ offered: true, reach: "x" }).buttons.find((button) => button.props.children === "Allow once")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastingGrant: undefined, scope: "once" }));
  });
});

describe("a card that offers no Always", () => {
  it.each([
    ["always-asks", "This one always asks."],
    ["owner-only", "Only the owner can choose Always."],
    ["secret", "This one asks each time: it holds a password or key."],
    ["incomplete", "This one asks each time: later.dog cannot see all of what it does."],
    ["screen", "This one asks each time: it acts on what is on the screen then."],
    ["teammate", "This one asks each time: a teammate can reach things this dog cannot."],
    ["state", "This one asks each time: it acts on things as they are then."],
  ] as const)("shows one quiet line for %s where the button would sit", (why, line) => {
    const result = view({ offered: false, why });
    expect(labels(result.buttons)).toEqual(["Allow once", "Don't allow"]);
    expect(result.html).toContain(line);
    expect(result.html).toContain(`data-lasting-why="${why}"`);
  });

  it("leaves a card that still carries an old key as it was", () => {
    const result = view(undefined, { tool: "ask_bot", allowKey: "ask_bot:dog-2" });
    expect(labels(result.buttons)).toEqual(["Allow once", "Don't allow", "Always allow"]);
    expect(result.html).not.toContain("data-lasting-why");
  });
});
