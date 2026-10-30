import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

import { MAC_ALLOW_KEY } from "../../shared/cloud-home";
import { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } from "./PendingApproval";

const bot = { id: "bot-1", name: "Scout" } as Bot;
const words = "To Mom (5550101234)\n\nI'll bring tiramisu!";
function message(tool: string, extra: Partial<NonNullable<Message["card"]>> = {}): Message {
  return {
    id: "approval-1", at: 1, role: "bot", kind: "options",
    card: { title: "Jo's MacBook Air", subtitle: words, options: ["Allow", "Deny"], tool, requestId: "request-1", approvalScope: "local-computer", ...extra },
  };
}
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function view(tool: string, extra: Partial<NonNullable<Message["card"]>> = {}) {
  const pending = pendingApprovals([message(tool, extra)])[0]!;
  const actions = PendingApprovalActions({ pending, bot, threadId: "thread-1" });
  const buttons = nodes(actions).filter((node) => node.type === "button");
  return {
    panel: renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0, botName: bot.name })),
    labels: buttons.map((button) => renderToStaticMarkup(button).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'")),
    buttons,
  };
}

beforeEach(() => fixture.dispatch.mockReset());

describe("a text or email a dog wants to send from the Mac", () => {
  it("shows the whole message and offers only Send and Don't send", () => {
    const text = view("mac_send_text");
    expect(text.panel).toContain("Let Scout send a text from your Mac?");
    expect(text.panel).toContain("To Mom (5550101234)\n\nI&#x27;ll bring tiramisu!");
    expect(text.labels).toEqual(["Send", "Don't send"]);
    expect(view("mac_send_email").labels).toEqual(["Send", "Don't send"]);
  });

  it("refuses only this message on Don't send, leaving the Mac's own setting alone", () => {
    const { buttons } = view("mac_send_text");
    buttons[1]!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", requestId: "request-1", behavior: "deny", scope: undefined }));
    buttons[0]!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "allow", scope: "once", alwaysAllow: undefined }));
  });

  it("keeps Allow once, Always allow and Never on the Mac's other cards", () => {
    expect(view("mac_read_texts", { subtitle: "with Mom", allowKey: MAC_ALLOW_KEY }).labels).toEqual(["Allow once", "Always allow", "Never"]);
    expect(view("mac_run_command", { subtitle: "ls", allowKey: MAC_ALLOW_KEY }).labels).toEqual(["Allow once", "Always allow", "Never"]);
  });
});
