// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store-selectors", async (original) => ({ ...await original<typeof import("@/state/store-selectors")>(), ...await (await import("@/testing/store-selectors")).selectorsOverMockedStore() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

const { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } = await import("./PendingApproval");
const { ApprovalCard } = await import("./ApprovalCard");
const { setLocale } = await import("@/lib/i18n");

const otis = { id: "otis", name: "Otis", threadId: "thread-1", tasks: [] } as unknown as Bot;
const command = (card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "approval-1", at: 1, role: "bot", kind: "options",
  card: { title: "Approval needed", subtitle: "pnpm test --filter menu", options: ["Allow", "Deny"], tool: "Bash", requestId: "request-1", allowKey: "Bash", ...card },
});

let host: HTMLDivElement;
let root: Root;
const draw = async (message: Message, onCancelTurn?: () => void) => {
  const pending = pendingApprovals([message])[0]!;
  await act(async () => root.render(createElement(Fragment, null,
    createElement(PendingApprovalPanel, { pending, count: 1, index: 0, botName: "Otis", coversId: "covers-1", ...(onCancelTurn ? { onCancelTurn } : {}) }),
    createElement(PendingApprovalActions, { pending, threadId: "thread-1", bot: otis, coversId: "covers-1" }))));
};
const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the permission card", () => {
  it("asks in one plain title with no × and no hand", async () => {
    await draw(command(), vi.fn());
    expect(host.querySelector("[data-approval-title]")!.textContent).toBe("Let Otis run a command?");
    expect(host.querySelector('[aria-label="Stop"], .lucide-x, .lucide-hand')).toBeNull();
  });

  it("puts Always allow quietly at the left and Allow last", async () => {
    await draw(command());
    expect(buttons()).toEqual(["Always allow", "Don't allow", "Allow once"]);
    expect(host.querySelector("[data-approval-actions] .mr-auto")!.textContent).toBe("Always allow");
  });

  it("shows what the permission covers on a click on the command", async () => {
    await draw(command());
    const covers = host.querySelector<HTMLDetailsElement>("[data-approval-covers]")!;
    expect(covers.open).toBe(false);
    await act(async () => { host.querySelector<HTMLElement>("[data-approval-command]")!.click(); });
    expect(covers.open).toBe(true);
  });
});

describe("a settled permission", () => {
  it("is one line that says what the person chose", async () => {
    await act(async () => root.render(createElement(ApprovalCard, { bot: { name: "Otis" }, message: command({ answered: "allow", answerScope: "once" }) })));
    expect(host.querySelector("[data-approval-settled]")!.textContent).toBe("You allowed Otis to run a command");
    await act(async () => root.render(createElement(ApprovalCard, { bot: { name: "Otis" }, message: command({ answered: "deny" }) })));
    expect(host.textContent).toBe("You didn't allow Otis to run a command");
  });
});
