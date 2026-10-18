import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, type Bot } from "@/state/store";
import { FolderIcon, NewThreadButton } from "./BotProjects";

vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({
  ...await original<object>(),
  useStore: () => ({ dispatch }),
}));

const bot: Bot = {
  id: "dog", threadId: "current", name: "Dog", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "mail", name: "Email", emoji: "📬" }],
  tasks: [{ threadId: "current", title: "Inbox", projectId: "mail", createdAt: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
});
afterEach(() => vi.unstubAllGlobals());

describe("folder controls", () => {
  it("uses an optional decorative emoji with the generic folder as its default", () => {
    const generic = renderToStaticMarkup(createElement(FolderIcon, {}));
    expect(generic).toContain("lucide-folder");
    const emoji = renderToStaticMarkup(createElement(FolderIcon, { emoji: "📬" }));
    expect(emoji).toContain("📬");
    expect(emoji).toContain('aria-hidden="true"');
    expect(emoji).not.toContain("lucide-folder");
  });
  it("keeps New thread as one plain button without a folder dropdown", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(NewThreadButton, { bot })));
    expect(markup).toContain('title="New thread in Email"');
    expect(markup).not.toContain("aria-haspopup");
    expect(markup).not.toContain("Choose folder");
    expect(markup.match(/<button /g)).toHaveLength(1);
  });
  it.each([
    { projectId: "mail", expected: { type: "newTask", botId: "dog", projectId: "mail" } },
    { projectId: undefined, expected: { type: "newTask", botId: "dog" } },
    { projectId: "deleted", expected: { type: "newTask", botId: "dog" } },
  ])("creates one thread in the current valid folder ($projectId), then closes its picker", ({ projectId, expected }) => {
    const onCreated = vi.fn();
    const button = NewThreadButton({
      bot: { ...bot, tasks: [{ ...bot.tasks![0]!, projectId }] },
      compact: true,
      onCreated,
    });

    button.props.onClick();

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expected);
    expect(onCreated).toHaveBeenCalledOnce();
    expect(button.props["aria-label"]).toBe("New thread");
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(onCreated.mock.invocationCallOrder[0]!);
  });
});
