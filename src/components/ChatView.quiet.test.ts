import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const view = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { showToolCalls: false };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: {
      ...original.initialState,
      config: { features: { showToolCalls: view.showToolCalls } },
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo],
    },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
const folded = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock("./FoldLine", async (importOriginal) => {
  const original = await importOriginal<typeof import("./FoldLine")>();
  return { ...original, FoldLine: (props: Parameters<typeof original.FoldLine>[0]) => { folded.props.push({ ...props }); return original.FoldLine(props); } };
});

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const chain = (messages: Omit<Message, "parentId">[]): Message[] =>
  messages.map((message, index) => ({ ...message, parentId: messages[index - 1]?.id }) as Message);
const turn = "turn-1";
const transcript = (terminal: boolean) => chain([
  { id: "ask", role: "user", kind: "text", text: "Sign in to my mail", at: 1_000 },
  { id: "opening", role: "bot", kind: "text", text: "Opening the sign-in page on the cloud computer.", turnId: turn, at: 2_000 },
  { id: "click", role: "bot", kind: "activity", tool: { name: "mcp__computer__click", ok: true }, turnId: turn, at: 3_000 },
  { id: "look", role: "bot", kind: "activity", tool: { name: "mcp__computer__screenshot", ok: true }, turnId: turn, at: 4_000 },
  { id: "shot", role: "bot", kind: "text", text: "", attachments: [{ kind: "image", path: "/attachments/shot.png", mime: "image/png" }], turnId: turn, at: 4_500 },
  { id: "chatter", role: "bot", kind: "text", text: "The page loaded, clicking Sign In now.", turnId: turn, at: 5_000 },
  { id: "form", role: "bot", kind: "activity", tool: { name: "mcp__computer__request_secure_form", ok: true }, turnId: turn, at: 6_000 },
  { id: "final", role: "bot", kind: "text", text: "Tap Open on the form to sign in.", turnId: turn, turnTerminal: terminal, at: 9_000 },
]);
const bot = (messages: Message[], busy: boolean): Bot => ({
  id: "bot", threadId: "t1", name: "Ivy", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, turnStartedAt: busy ? 1_500 : undefined, messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "test", model: "m" },
});
const render = (b: Bot) => renderToStaticMarkup(createElement(ChatView, { bot: b }));

describe("a quiet chat", () => {
  it("keeps everything the dog said as bubbles, with one grey sentence above the answer and no screenshots", () => {
    const markup = render(bot(transcript(true), false));
    expect(markup).toContain("Opening the sign-in page on the cloud computer.");
    expect(markup).toContain("The page loaded, clicking Sign In now.");
    expect(markup).toContain("Tap Open on the form to sign in.");
    expect(/data-fold-line="[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(markup)![1].replace(/<[^>]+>/g, "")).toBe("Looked at the screen 2 times, did something");
    expect(markup).not.toContain("Worked for");
    expect(markup).not.toContain("/attachments/shot.png");
    expect(markup.indexOf("Looked at the screen 2 times")).toBeLessThan(markup.indexOf("Tap Open on the form to sign in."));
    expect(markup.indexOf("The page loaded")).toBeLessThan(markup.indexOf("Looked at the screen 2 times"));
  });

  it("keeps what the dog says while it works, and no fold until the turn ends", () => {
    const live = transcript(false).slice(0, -1);
    const markup = render(bot(live, true));
    expect(markup).toContain("Opening the sign-in page on the cloud computer.");
    expect(markup).toContain("The page loaded, clicking Sign In now.");
    expect(markup).not.toContain("data-fold-line");
    expect(markup).not.toContain("/attachments/shot.png");
  });

  it("hands the fold a run id only when the turn has a native run, never the turn's own id", () => {
    folded.props.length = 0;
    render(bot(transcript(true), false));
    expect(folded.props).toHaveLength(1);
    expect(folded.props[0]).toMatchObject({ threadId: "t1" });
    expect(folded.props[0].runId).toBeUndefined();
  });

  it("shows the fold with no setting, and the old step setting changes nothing", () => {
    view.showToolCalls = true;
    try {
      const markup = render(bot(transcript(true), false));
      expect(markup).toContain("data-fold-line");
      expect(markup).not.toContain("/attachments/shot.png");
      expect(markup).not.toContain("mcp__computer__click");
      expect(markup).not.toContain('data-testid="tool-activity"');
    } finally {
      view.showToolCalls = false;
    }
  });
});

it("puts two sends to one dog, with a hidden coordinate call between them, in one team block in the actual chat", () => {
  const receipt = (id: string): Message => ({ id, role: "bot", kind: "activity", at: 1000,
    tool: { name: "Sent to main app", ok: true }, threadRef: { botId: "main-app", threadId: id, title: "Work" },
  });
  const markup = render(bot(chain([receipt("one"),
    { id: "tool", role: "bot", kind: "activity", at: 1000, tool: { name: "coordinate_bots", ok: true } }, receipt("two")]), false));
  expect(markup.match(/data-team-block=/g)).toHaveLength(1);
  expect(markup).toContain('data-team-block="2"');
  expect(markup).toContain("Asked 1 dog");
  expect(markup.match(/data-team-name/g)).toHaveLength(2);
  expect(markup).not.toContain("data-sent-messages");
  expect(markup).not.toContain(">Messaged<");
});

it("renders five failed handoffs as one counted row in the actual chat", () => {
  const messages: Message[] = Array.from({ length: 5 }, (_, index) => ({ id: `failure-${index}`, role: "bot", kind: "activity", at: 1000,
    roomRequest: { id: `request-${index}`, phase: "result" },
    tool: { name: "main desk couldn't finish", ok: false },
    ...(index === 4 ? { comm: { groupId: "room", withBotId: "desk", withName: "main desk", withColor: "blue" as const } }
      : { threadRef: { botId: "desk", threadId: `work-${index}`, title: "Work" } }),
  }));
  const markup = render(bot(chain(messages), false));
  expect(markup.match(/data-failed-results/g)).toHaveLength(1);
  expect(markup).toContain("· 5");
  expect(markup).toContain("hover:text-danger");
});
