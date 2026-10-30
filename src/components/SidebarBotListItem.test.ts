import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotDeleteMenuItem, BotListItem, botDeleteCopy, botRowProps } from "./Sidebar";
import { endCall } from "@/lib/call";
import { configureLiveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

function renderRow(candidate: Bot, density: "comfortable" | "icons" = "comfortable") {
  return renderToStaticMarkup(createElement(BotListItem, botRowProps(initialState, vi.fn(), candidate, { density, onMenu: vi.fn() })));
}

afterEach(() => {
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("BotListItem", () => {
  it("offers only the keyboard-accessible dog menu, with no thread or folder buttons", () => {
    const markup = renderRow(bot({
      tasks: [{ threadId: "thread-atlas", title: "Current", createdAt: 2 }, { threadId: "thread-earlier", title: "Earlier", createdAt: 1 }],
      projects: [{ id: "p1", name: "Research" }],
    }));
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('role="button" tabindex="0"');
    for (const gone of ["New thread", "New folder", "Expand Atlas threads", "data-sidebar-thread-row=", "Earlier", "Research"]) expect(markup).not.toContain(gone);
  });

  it("previews the last reply, not the digest receipt that follows it", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "make notes.txt", at: 1 },
        { id: "b1", role: "bot", kind: "text", text: "Created notes.txt with three lines.", at: 2 },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("Created notes.txt with three lines.");
    expect(markup).not.toContain("[digest]");
  });

  it("previews the reply, not a tool call that followed it, while tool calls are hidden", () => {
    const messages = [
      { id: "u1", role: "user", kind: "text", text: "list the files", at: 1 },
      { id: "b1", role: "bot", kind: "text", text: "Here are the files.", at: 2 },
      { id: "a1", role: "bot", kind: "activity", at: 3, tool: { name: "Bash", ok: true } },
    ] as Bot["messages"];
    const hidden = renderRow(bot({ messages }));
    expect(hidden).toContain("Here are the files.");
    expect(hidden).not.toContain(">Bash<");
    const shown = renderToStaticMarkup(createElement(BotListItem, botRowProps(
      { ...initialState, config: { features: { skillAuthoring: false, showToolCalls: true } } } as typeof initialState,
      vi.fn(), bot({ messages }), { density: "comfortable", onMenu: vi.fn() },
    )));
    expect(shown).toContain(">Bash<");
  });

  it("previews a failed turn without its error marker", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "check the site", at: 1 },
        { id: "e1", role: "bot", kind: "activity", at: 2, tool: { name: "error: This computer isn't a place on your later.dog Cloud: its bots run in the cloud.", ok: false } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("This computer isn&#x27;t a place on your later.dog Cloud: its bots run in the cloud.");
    expect(markup).not.toContain("error:");
  });

  it("previews a markdown reply as plain words", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "test the tools", at: 1 },
        { id: "b1", role: "bot", kind: "text", text: "## Tool test complete\n\n- [x] Created `notes.md`\n- [x] Read it back", at: 2 },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("Tool test complete Created notes.md Read it back");
    expect(markup).not.toContain("##");
    expect(markup).not.toContain("[x]");
  });

  it("marks an unread row so the More unreads pill can find it, and says what a waiting dog waits for on the icon rail", () => {
    expect(renderRow(bot({ unread: true }))).toContain("data-sidebar-unread");
    expect(renderRow(bot())).not.toContain("data-sidebar-unread");
    const waiting = renderRow(bot({
      activity: "waiting-on-you",
      messages: [{ id: "c1", role: "bot", kind: "options", at: 2, card: { title: "Approval needed", subtitle: "ls", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } }] as Bot["messages"],
    }), "icons");
    expect(waiting).toContain('aria-label="Atlas · Waiting for you: run a command"');
  });

  it("previews a person's own last message exactly as typed", () => {
    const markup = renderRow(bot({
      messages: [{ id: "u1", role: "user", kind: "text", text: "rename *draft* to final", at: 1 }] as Bot["messages"],
    }));
    expect(markup).toContain("rename *draft* to final");
  });

  describe("an approval card that ends the chat", () => {
    const approval = (card: Partial<NonNullable<Bot["messages"][number]["card"]>>): Bot => bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "list the files", at: 1 },
        {
          id: "c1", role: "bot", kind: "options", at: 2,
          card: { title: "Approval needed", subtitle: "ls -la", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...card },
        },
      ] as Bot["messages"],
    });

    it("keeps the request's title while it is still open", () => {
      expect(renderRow(approval({}))).toContain("Approval needed");
    });

    it("says Allowed once it was allowed", () => {
      const markup = renderRow(approval({ answered: "allow" }));
      expect(markup).toContain("Allowed");
      expect(markup).not.toContain("Approval needed");
    });

    it("says Denied once it was denied, or closed by Stop", () => {
      for (const answered of ["deny", "unavailable"]) {
        const markup = renderRow(approval({ answered, dismissed: answered === "unavailable" }));
        expect(markup).toContain("Denied");
        expect(markup).not.toContain("Approval needed");
      }
    });

    it("says nobody answered in time once nothing can answer it", () => {
      const markup = renderRow(approval({ expired: true, options: [] }));
      expect(markup).toContain("No answer in time");
      expect(markup).not.toContain("Approval needed");
    });
  });

  it("leaves the full main dog row as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }));

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Hide Atlas"');
  });

  it("puts no second dot on the main dog's avatar", () => {
    const main = renderRow(bot({ chiefOfStaff: true, title: "Developer" }));
    expect(main).not.toContain('data-testid="main-dog-badge"');
    expect(main).not.toContain("Chief of Staff");
  });

  const titleLine = /<div class="truncate text-\[11px\][^"]*">([^<]*)<\/div>/;

  it("shows the bot's title on its own line above the name, not a badge beside it", () => {
    const markup = renderRow(bot({ title: "Developer" }));

    expect(titleLine.exec(markup)?.[1]).toBe("Developer");
    expect(markup.indexOf(">Developer<")).toBeLessThan(markup.indexOf(">Atlas<"));
    expect(markup).toContain('title="Double-click to rename"');

    expect(titleLine.test(renderRow(bot()))).toBe(false);
    expect(titleLine.test(renderRow(bot({ title: "  " })))).toBe(false);
  });

  it("keeps the title line's own truncate class instead of a shared-line width cap", () => {
    const longTitle = "Meta-Agent — opensource team maintainer";
    const markup = renderRow(bot({ name: "Team Maintainer", title: longTitle }));

    expect(titleLine.exec(markup)?.[1]).toBe(longTitle);
    expect(markup).toContain(">Team Maintainer<");
    expect(markup).not.toContain("max-w-[45%]");
  });

  it("shows typing dots instead of preview text while the bot works", () => {
    const markup = renderRow(bot({ busy: true }));

    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('class="sr-only">Working…');
  });

  it("shows work on the dog's face and preview, never with a dot", () => {
    const markup = renderRow(bot({ busy: true }));
    expect(markup).not.toContain("data-status=");
    expect(markup).toContain('data-mood="think"');
    expect(renderRow(bot({ busy: true }), "icons")).not.toContain("data-status=");
  });

  it("gives a waiting dog an orange dot and orange words, in place of the blue unread dot", () => {
    const waiting = renderRow(bot({ busy: true, activity: "waiting-on-you", unread: true }));
    expect(waiting).toContain('data-testid="waiting-dot"');
    expect(waiting).toContain("text-waiting-text");
    expect(waiting).not.toContain('data-testid="unread-dot"');
    const unread = renderRow(bot({ unread: true }));
    expect(unread).toContain('data-testid="unread-dot"');
    expect(unread).toContain("bg-unread");
    expect(unread).not.toContain("text-waiting-text");
    expect(renderRow(bot({ unread: true }), "icons")).toContain('data-testid="unread-dot"');
    expect(renderRow(bot())).not.toContain("data-status=");
  });

  it("marks the bot this window is on a Live call with by a green phone badge", () => {
    expect(renderRow(bot())).not.toContain('data-testid="live-call-badge"');

    vi.stubGlobal("window", { laterdog: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: "atlas", threadId: "thread-atlas" });

    const markup = renderRow(bot());
    expect(markup).toContain('data-testid="live-call-badge"');
    expect(markup).toContain('aria-label="On a Live call"');
    expect(markup.indexOf('data-testid="live-call-badge"')).toBeGreaterThan(markup.indexOf(">Atlas<"));
    expect(renderRow(bot({ id: "other" }))).not.toContain('data-testid="live-call-badge"');

    const icons = renderRow(bot(), "icons");
    expect(icons).toContain('data-testid="live-call-badge"');
    expect(icons).toContain('aria-label="Atlas · On a Live call"');
  });

  it("tells you an idle bot waits on a teammate in words, never with the work signals", () => {
    const markup = renderRow(bot({ waitingForTeammates: true, busy: false, activity: "idle" }));
    expect(markup).not.toContain("data-status=");
    expect(markup).not.toContain("animate-status-pulse");
    expect(markup).toContain("Waiting on another dog…");
  });

  it("keeps real sibling work visible while another thread waits for a teammate", () => {
    const markup = renderRow(bot({ waitingForTeammates: true, busy: true, activity: "working" }));
    expect(markup).toContain("animate-status-pulse");
    expect(markup).not.toContain("Waiting on another dog…");
  });

  it("keeps Hide in the Actions menu and reveals quiet row controls on focus as well as hover", () => {
    const markup = renderRow(bot());
    expect(markup).not.toContain("Hide from sidebar");
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain("group-focus-within:opacity-100");
    expect(markup).toContain("group-hover:pointer-events-auto");
    expect(markup).not.toContain("pr-[92px]");
  });
});

describe("delete confirmation", () => {
  it("delete copy names the bot and warns about its owned computer", () => {
    const copy = botDeleteCopy("Willow");

    expect(copy.title).toContain("Willow");
    expect(copy.body).toMatch(/permanently/i);
    expect(copy.body).toMatch(/any computer it owns/i);
    expect(copy.body).toMatch(/files and browser sign-ins/i);
    expect(copy.body).not.toMatch(/pack/i);
    expect(copy.tone).toBe("danger");
  });

  it("renders as an alert dialog with Cancel and the action button", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...botDeleteCopy("Willow"),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Willow?");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain("bg-danger");
  });
});

describe("bot deletion feedback", () => {
  it("disables the destructive action while the bot and its computer are deleted", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: true,
      onClick: vi.fn(),
    }));

    expect(markup).toContain("Deleting dog and owned computer…");
    expect(markup).toContain('title="Deleting this dog and any computer it owns"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("offers Delete again after the check settles", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: false,
      onClick: vi.fn(),
    }));

    expect(markup).toContain(">Delete</button>");
    expect(markup).not.toContain('disabled=""');
  });

  describe("row lines", () => {
    it("says what the dog is waiting on when its approval card is open", () => {
      const card = (extra: Record<string, unknown> = {}) => ({
        id: "ask-1", role: "bot", kind: "options", at: 3,
        card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...extra },
      }) as Bot["messages"][number];
      const markup = renderRow(bot({ activity: "waiting-on-you", messages: [card()] }));
      expect(markup).toContain('<span class="truncate text-waiting-text">Waiting for you: run a command</span>');
      expect(markup).not.toContain('<span class="truncate text-waiting-text">Waiting for you…');
      expect(renderRow(bot({ activity: "waiting-on-you", messages: [card({ tool: "mac_run_command" })] }))).toContain("Waiting for you: run a command on your Mac");
      expect(renderRow(bot({ activity: "waiting-on-you", messages: [card({ answered: "deny" })] }))).toContain('<span class="truncate text-waiting-text">Waiting for you…');
    });

    it("keeps the title line for the main dog", () => {
      expect(/<div class="truncate text-\[11px\][^"]*">([^<]*)<\/div>/.exec(renderRow(bot({ title: "Developer", chiefOfStaff: true })))?.[1]).toBe("Developer");
    });
  });
});
