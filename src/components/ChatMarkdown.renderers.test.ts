import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return { ...actual, default: (props: Record<string, unknown>) => { captured.push(props); return null; } };
});
vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) };
});

import { fromMarkdown } from "mdast-util-from-markdown";
import { ChatMarkdown } from "./ChatMarkdown";

function markdownProps(text: string): Record<string, unknown> {
  captured.length = 0;
  renderToStaticMarkup(createElement(ChatMarkdown, { text, message: { threadId: "t", messageId: "m" } }));
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("ChatMarkdown element renderers", () => {
  it("hands react-markdown the same renderers for every message", () => {
    const first = markdownProps("Tracked in #QA PR 245.\n\n```ts\nconst kept = true;\n```");
    expect(markdownProps("Done in [QA](LaterDog://thread/qa-245?bot=scout).").components).toBe(first.components);
    expect(markdownProps("Another message").components).toBe(first.components);
  });
});

describe("ChatMarkdown normalization", () => {
  beforeEach(() => vi.mocked(fromMarkdown).mockClear());

  it("parses a message for table repair and math once, however often it renders", () => {
    const text = "## Costs\n\n| Step | Cost |\n|---|\n| build | 5 |\n\nArea \\(x^2\\).";
    const first = markdownProps(text);
    expect(first.children).toContain("$x^2$");
    expect(fromMarkdown).toHaveBeenCalledTimes(2);

    const second = markdownProps(text);
    expect(second.children).toBe(first.children);
    expect(fromMarkdown).toHaveBeenCalledTimes(2);
  });

  it("remembers a bounded number of messages, newest kept", () => {
    const oldest = "The oldest message.";
    markdownProps(oldest);
    for (let i = 0; i < 1000; i++) markdownProps(`Message ${i}.`);

    vi.mocked(fromMarkdown).mockClear();
    markdownProps("Message 999.");
    expect(fromMarkdown).not.toHaveBeenCalled();
    markdownProps(oldest);
    expect(fromMarkdown).toHaveBeenCalledOnce();
  });
});
