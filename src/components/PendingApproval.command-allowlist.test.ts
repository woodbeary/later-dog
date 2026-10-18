import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

import { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } from "./PendingApproval";

const commandAllowlist = { command: "git status --short", cwd: "/work/project", providerInstanceId: "claude" };
const bot = { id: "bot-1", name: "Scout" } as Bot;
function message(extra: Partial<NonNullable<Message["card"]>> = {}): Message {
  return {
    id: "approval-1", at: 1, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: commandAllowlist.command, options: ["Allow", "Deny"],
      tool: "Bash", requestId: "request-1", allowSession: true, commandAllowlist, ...extra },
  };
}
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function view(extra: Partial<NonNullable<Message["card"]>> = {}, asker: Bot = bot) {
  const pending = pendingApprovals([message(extra)])[0]!;
  const tree = PendingApprovalActions({ pending, bot: asker, threadId: "thread-1" });
  return { html: renderToStaticMarkup(tree), buttons: nodes(tree).filter((node) => node.type === "button") };
}

beforeEach(() => { fixture.admin = true; fixture.dispatch.mockReset(); });

describe("remembering exact command approvals", () => {
  it("shows the complete command being remembered even when the provider summary was truncated", () => {
    const fullCommand = `git diff ${"path/to/another-file ".repeat(30)}-- final-file.txt`;
    const summary = fullCommand.slice(0, 200) + "…";
    const pending = pendingApprovals([message({ subtitle: summary, commandAllowlist: { ...commandAllowlist, command: fullCommand } })])[0]!;
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));
    expect(html).toContain(fullCommand);
    expect(html).toContain("-- final-file.txt");
    expect(html).not.toContain(summary);
  });

  it("keeps the provider summary when there is no exact command to remember", () => {
    const summary = "Review the proposed file changes.";
    const pending = pendingApprovals([message({ subtitle: summary, commandAllowlist: undefined })])[0]!;
    expect(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }))).toContain(summary);
  });

  it("forwards eligibility supplied by the server without deriving a grant from the tool label", () => {
    expect(pendingApprovals([message()])[0]?.commandAllowlist).toEqual(commandAllowlist);
    expect(pendingApprovals([message({ commandAllowlist: undefined })])[0]?.commandAllowlist).toBeUndefined();
    expect(view({ commandAllowlist: undefined }).html).not.toContain("Always allow");
  });

  it("answers and remembers in one action without a separate preference update", () => {
    const result = view();
    expect(result.html).toContain("Always allow");
    expect(result.html).toContain("/work/project");
    expect(result.html).not.toContain("Allow for this chat");
    result.buttons.find((button) => button.props.children === "Always allow")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "decideRequest", threadId: "thread-1", requestId: "request-1", behavior: "allow", rememberCommand: true,
      alwaysAllow: undefined, always: undefined,
    }));
  });

  it("keeps Allow once and Deny from saving a grant", () => {
    for (const [label, behavior] of [["Allow once", "allow"], ["Don't allow", "deny"]]) {
      fixture.dispatch.mockClear();
      view().buttons.find((button) => button.props.children === label)!.props.onClick!();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        behavior, rememberCommand: undefined, alwaysAllow: undefined, always: undefined,
      }));
    }
  });

  it("puts Allow once first and primary, and a durable grant last, outlined and set apart", () => {
    for (const extra of [{}, { commandAllowlist: undefined }, { allowKey: "peer:teammate" }] as const) {
      const { buttons } = view(extra);
      const labels = buttons.map((button) => String(button.props.children));
      expect(labels[0]).toBe("Allow once");
      expect(labels[1]).toBe("Don't allow");
      expect(labels.at(-1)).toMatch(/^(Always allow|Allow for this chat)$/);
      const classes = (button: (typeof buttons)[number]) => String((button.props as unknown as { className?: string }).className);
      expect(classes(buttons[0]!)).toContain("bg-accent");
      expect(classes(buttons.at(-1)!)).not.toContain("bg-accent");
      expect(classes(buttons.at(-1)!)).toContain("border");
      expect(classes(buttons.at(-1)!)).toContain("ml-3");
    }
  });

  it("never puts a durable grant on a durable confirmation or ahead of the single-use choice", () => {
    const { buttons } = view({ allowKey: "peer:teammate" });
    expect(buttons.findIndex((button) => button.props.children === "Allow once"))
      .toBeLessThan(buttons.findIndex((button) => button.props.children === "Always allow"));
  });

  it.each([false, null])("keeps bot-wide grants unavailable without owner/admin authority (%s)", (admin) => {
    fixture.admin = admin;
    const result = view();
    expect(result.html).not.toContain("Always allow");
    expect(result.html).toContain("Allow for this chat");
    expect(result.html).toContain("Allow once");
  });

  it("preserves session approval for requests without an exact command", () => {
    view({ commandAllowlist: undefined }).buttons.find((button) => button.props.children === "Allow for this chat")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      behavior: "allow", always: true, rememberCommand: undefined,
    }));
  });

  it("keeps peer grants separate from provider command rules", () => {
    const result = view({ allowKey: "peer:teammate" });
    expect(result.buttons.filter((button) => button.props.children === "Always allow")).toHaveLength(1);
    result.buttons.find((button) => button.props.children === "Always allow")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      alwaysAllow: { botId: bot.id, key: "peer:teammate" }, always: undefined, rememberCommand: undefined,
    }));
  });

  it("shows the command open in a capped mono block, not behind View details", () => {
    const pending = pendingApprovals([message()])[0]!;
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));
    expect(html).not.toContain("View details");
    expect(html).not.toContain("<details");
    expect(html).toMatch(/<pre[^>]*class="[^"]*max-h-40[^"]*font-mono[^"]*"[^>]*>git status --short<\/pre>/);
  });

  it("folds model proposals behind View details, as the chat card does", () => {
    for (const extra of [{ tool: "update_model", modelRequest: {} }]) {
      const pending = pendingApprovals([message({ ...extra, subtitle: "proposal body", commandAllowlist: undefined } as never)])[0]!;
      const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));
      expect(html).toContain("<details");
      expect(html).toContain("View details");
    }
  });

  it("says in one visible line how far each lasting choice reaches", () => {
    const line = (html: string) => html.match(/<p class="[^"]*text-ink-tertiary[^"]*">([^<]*)<\/p>/)?.[1];
    const command = view();
    expect(line(command.html)).toBe("Always allow lets Scout run this exact command in /work/project without asking, in any chat using that folder with this engine.");
    expect(line(view({ commandAllowlist: undefined }).html)).toBe("Allow for this chat stops asking about this action until this chat&#x27;s session ends.");
    const ownChat = { ...bot, tasks: [{ threadId: "thread-1" }] } as Bot;
    expect(line(view({ allowKey: "ask_bot:kiwi" }, ownChat).html)).toBe("Always allow lets Scout do this again without asking in this chat.");
    expect(line(view({ allowKey: "ask_bot:kiwi" }).html)).toBe("Always allow lets Scout do this again without asking in group chats and in new chats.");
    expect(line(view({ allowKey: "mac" }).html)).toBe("Always allow lets every dog use your Mac without asking.");
    for (const button of command.buttons) expect((button.props as { title?: string }).title).toBeUndefined();
    expect(line(view({ commandAllowlist: undefined, allowSession: false }).html)).toBeUndefined();
  });

  it("never offers remembered commands on a durable confirmation", () => {
    const result = view({ routineRequest: { version: 1, requestId: "request-1", botId: bot.id, threadId: "thread-1", createdAt: 1,
      operation: { action: "run_now", routineId: "routine-1", expectedUpdatedAt: 1 } } });
    expect(result.html).not.toContain("Always allow");
    expect(result.html).toContain("Confirm");
  });
});
