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
  it("shows Always allow, Don't allow and Allow once, and says what it covers", () => {
    const result = view({ offered: true, reach: "server words" });
    expect(labels(result.buttons)).toEqual(["Always allow", "Don't allow", "Allow once"]);
    expect(result.html).toContain("Always allow lets Wren search for exactly this again without asking, in any of its chats.");
    expect(result.html).not.toContain("Allow for this chat");
  });

  it("grants for the dog and answers the card as always", () => {
    view({ offered: true, reach: "x" }).buttons.find((button) => button.props.children === "Always allow")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "decideRequest", threadId: "thread-1", requestId: "request-1", behavior: "allow",
      lastingGrant: { botId: "bot-1" }, alwaysAllow: undefined, scope: "always",
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
    ["group", "Always isn't offered in group chats."],
    ["secret", "This one asks each time: it holds a password or key."],
    ["incomplete", "This one asks each time: later.dog cannot see all of what it does."],
    ["screen", "This one asks each time: it acts on what is on the screen then."],
    ["teammate", "This one asks each time: a teammate can reach things this dog cannot."],
    ["state", "This one asks each time: it acts on things as they are then."],
  ] as const)("shows one quiet line for %s where the button would sit", (why, line) => {
    const result = view({ offered: false, why });
    expect(labels(result.buttons)).toEqual(["Don't allow", "Allow once"]);
    expect(result.html.replaceAll("&#x27;", "'")).toContain(line);
    expect(result.html).toContain(`data-lasting-why="${why}"`);
  });

  it("shows a member the owner-only line instead of Always, even when the dog could be offered it", () => {
    fixture.admin = false;
    const result = view({ offered: true, reach: "x" });
    expect(labels(result.buttons)).toEqual(["Don't allow", "Allow once"]);
    expect(result.html).toContain("Only the owner can choose Always.");
    expect(result.html).toContain('data-lasting-why="owner-only"');
    expect(result.html).not.toContain("without asking, in any of its chats");
  });

  it("follows the lasting answer over an old key the card still carries", () => {
    const refused = view({ offered: false, why: "state" }, { allowKey: "WebSearch:old" });
    expect(labels(refused.buttons)).toEqual(["Don't allow", "Allow once"]);
    expect(refused.html).toContain('data-lasting-why="state"');
    view({ offered: true, reach: "x" }, { allowKey: "WebSearch:old" }).buttons.find((button) => button.props.children === "Always allow")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastingGrant: { botId: "bot-1" }, alwaysAllow: undefined, scope: "always" }));
  });

  it("labels a connected-app card that always asks Allow once and Don't allow, with its line", () => {
    const outboundRequest = { tool: "GMAIL_DELETE_MESSAGE", app: "Gmail", calls: [{ app: "Gmail", label: "Delete message" }] };
    const asks = view({ offered: false, why: "always-asks" }, { title: "Allow Gmail?", subtitle: "Gmail · Delete message", tool: "GMAIL_DELETE_MESSAGE", outboundRequest });
    expect(labels(asks.buttons)).toEqual(["Don't allow", "Allow once"]);
    expect(asks.html).toContain("This one always asks.");
    const ordinary = view(undefined, { title: "Allow GitHub?", subtitle: "GitHub · Create an issue comment", tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", allowKey: "connector:github",
      outboundRequest: { tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", app: "GitHub", calls: [{ app: "GitHub", label: "Create an issue comment" }] } });
    expect(labels(ordinary.buttons).slice(-2)).toEqual(["Skip", "Allow"]);
  });

  it("tells the person that Don't allow on a connected-app card that always asks also holds that app back until their next message", () => {
    const outboundRequest = { tool: "GMAIL_DELETE_MESSAGE", app: "Gmail", calls: [{ app: "Gmail", label: "Delete message" }] };
    const asks = view({ offered: false, why: "always-asks" }, { title: "Allow Gmail?", subtitle: "Gmail · Delete message", tool: "GMAIL_DELETE_MESSAGE", outboundRequest });
    expect(asks.html).toContain("If you don&#x27;t allow it, Wren won&#x27;t ask about Gmail again until your next message.");
    const search = view({ offered: false, why: "always-asks" }, { tool: "Bash", subtitle: "git push --no-verify" });
    expect(search.html).not.toContain("won&#x27;t ask about");
  });

  it("never offers Allow for this chat", () => {
    const result = view(undefined, { allowSession: true } as Partial<NonNullable<Message["card"]>>);
    expect(labels(result.buttons)).toEqual(["Don't allow", "Allow once"]);
    expect(result.html).not.toContain("Allow for this chat");
  });

  it("leaves a card that still carries an old key as it was", () => {
    const result = view(undefined, { tool: "ask_bot", allowKey: "ask_bot:dog-2" });
    expect(labels(result.buttons)).toEqual(["Always allow", "Don't allow", "Allow once"]);
    expect(result.html).not.toContain("data-lasting-why");
  });
});
