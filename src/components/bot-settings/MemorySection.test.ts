import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MemoryCapacity, MemoryFileInfo, MemoryJournalRow } from "@/lib/memory";

vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "other" } } }),
}));

const { ConflictNotice, LendingReviewNotice, MemoryGauge, MemoryJournalList, MemoryLogs, MemoryNotes, MemoryUpkeepRows, noteLabel, topicTemplate } = await import("./MemorySection");

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

const index = (overrides: Partial<MemoryCapacity> = {}): MemoryCapacity => ({
  lines: 40,
  bytes: 2_000,
  maxLines: 200,
  maxBytes: 24_000,
  loadedLines: 40,
  loadedBytes: 2_000,
  truncated: false,
  hash: "h",
  ...overrides,
});

describe("MemoryGauge", () => {
  it("always carries the plain sentence about what loads", () => {
    const markup = render(createElement(MemoryGauge, { index: index() }));
    expect(markup).toContain("only the first 200 lines load each turn");
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain("bg-accent");
    expect(markup).not.toContain("bg-danger");
  });

  it("warns early, in one short line, when main memory is almost full", () => {
    const markup = render(createElement(MemoryGauge, { index: index({ lines: 170, loadedLines: 170 }) }));
    expect(markup).toContain("Almost full. Move details into a note to keep room.");
    expect(markup).toContain("bg-warning");
    expect(markup).not.toContain("bg-danger");
  });

  it("turns red and says how many lines are not being loaded", () => {
    const markup = render(createElement(MemoryGauge, { index: index({ lines: 260, loadedLines: 200, truncated: true }) }));
    expect(markup).toContain("60 lines are not being loaded");
    expect(markup).toContain("only the first 200 lines load each turn");
    expect(markup).toContain("bg-danger");
    expect(markup).toContain('aria-valuenow="100"');
  });
});

describe("ConflictNotice", () => {
  it("names the bot, promises nothing was saved, and offers both ways out", () => {
    const markup = render(createElement(ConflictNotice, { botName: "Scout", busy: false, onReload: vi.fn(), onOverwrite: vi.fn() }));
    expect(markup).toContain("Scout changed this note while you were editing.");
    expect(markup).toContain("Nothing has been saved.");
    expect(markup).toContain(">Reload<");
    expect(markup).toContain(">Overwrite with mine<");
  });
});

describe("MemoryNotes", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  const topics: MemoryFileInfo[] = [
    { path: "memory/clients.md", name: "clients.md", bytes: 120, modifiedAt: now - 3 * 60_000 },
  ];
  const notes = (capacity: MemoryCapacity, files: MemoryFileInfo[] = topics) =>
    render(createElement(MemoryNotes, { index: capacity, topics: files, now, onOpen: vi.fn(), onCreate: vi.fn(() => true) }));

  it("puts main memory first, then each note by name and age, then a way to add one", () => {
    const markup = notes(index());
    expect(markup.indexOf("Main memory")).toBeLessThan(markup.indexOf(">clients<"));
    expect(markup).toContain("Read in every chat");
    expect(markup).toContain("3 min ago");
    expect(markup).toContain("New note");
    expect(markup).not.toContain("clients.md<");
    expect(markup).not.toContain("120 B");
  });

  it("flags main memory when it is almost full or too long", () => {
    expect(notes(index({ lines: 170, loadedLines: 170 }))).toContain(">Almost full<");
    const over = notes(index({ lines: 260, loadedLines: 200, truncated: true }));
    expect(over).toContain(">Too long<");
    expect(over).not.toContain("Read in every chat");
  });

  it("shows the first few notes and offers the rest", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `memory/n${i}.md`, name: `n${i}.md`, bytes: 1, modifiedAt: now }));
    const markup = notes(index(), many);
    expect(markup.match(/data-memory-note="memory\//g)).toHaveLength(6);
    expect(markup).toContain("Show all 9");
  });
});

describe("MemoryLogs", () => {
  it("says what the daily logs are and labels each by its day", () => {
    const logs: MemoryFileInfo[] = [{ path: "memory/log/2026-09-08.md", name: "2026-09-08.md", bytes: 10, modifiedAt: 0 }];
    const markup = render(createElement(MemoryLogs, { logs, botName: "Scout", onOpen: vi.fn() }));
    expect(markup).toContain("What Scout did each day. Read-only, and never loaded into chats.");
    expect(markup).toContain(new Date(2026, 8, 8).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }));
    expect(render(createElement(MemoryLogs, { logs: [], botName: "Scout", onOpen: vi.fn() }))).toContain("None yet.");
  });
});

describe("note names", () => {
  it("reads as a person would say them", () => {
    expect(noteLabel("MEMORY.md")).toBe("Main memory");
    expect(noteLabel("memory/clients.md")).toBe("clients");
    expect(noteLabel("memory/log/2026-09-08.md")).toBe(new Date(2026, 8, 8).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }));
    expect(noteLabel("memory/log/notes.md")).toBe("notes");
  });

  it("starts a new note with the header the dog uses to find it", () => {
    expect(topicTemplate("clients.md")).toBe("---\ntitle: clients\ndescription: \naliases: []\n---\n\n");
  });
});

describe("MemoryJournalList", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  const rows: MemoryJournalRow[] = [
    {
      id: "r1",
      at: now - 3 * 60_000,
      botId: "b1",
      path: "MEMORY.md",
      actor: "bot",
      via: "turn",
      threadId: "t1",
      threadTitle: "Follow-up",
      kind: "edited",
      beforeHash: "a",
      afterHash: "b",
      diff: "--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,0 +1,2 @@\n+one\n+two",
      added: 2,
      removed: 0,
      canRevert: true,
    },
    {
      id: "r2",
      at: now - 26 * 3_600_000,
      botId: "b1",
      path: "memory/keys.md",
      actor: "bot",
      via: "turn",
      kind: "edited",
      beforeHash: "c",
      afterHash: "d",
      diff: "",
      added: 1,
      removed: 1,
      canRevert: false,
      revertUnavailableReason: "The earlier version contained sensitive text that was hidden, so it cannot be restored exactly.",
    },
  ];

  it("shows Loading… and the empty state", () => {
    expect(render(createElement(MemoryJournalList, { rows: null, botName: "Scout", reverting: null, onRevert: vi.fn() }))).toContain("Loading…");
    expect(render(createElement(MemoryJournalList, { rows: [], botName: "Scout", reverting: null, onRevert: vi.fn() }))).toContain("No changes recorded yet.");
  });

  it("reads each row as a sentence with the chat it came from, and offers Undo", () => {
    const markup = render(createElement(MemoryJournalList, { rows, botName: "Scout", reverting: null, onRevert: vi.fn(), now }));
    expect(markup).toContain("Scout added 2 lines to MEMORY.md");
    expect(markup).toContain("3 min ago");
    expect(markup).toContain("from chat “Follow-up”");
    expect(markup).toContain("+2 −0 · show what changed");
    expect(markup).toContain("+one");
    expect(markup.match(/>Undo</g)).toHaveLength(1);
    expect(markup).toContain("Can't undo");
    expect(markup).toContain("sensitive text that was hidden");
    expect(markup).toContain("Scout rewrote 1 line in the keys topic");
    expect(markup).toContain("yesterday");
  });

  it("marks the row being undone", () => {
    const markup = render(createElement(MemoryJournalList, { rows, botName: "Scout", reverting: "r1", onRevert: vi.fn(), now }));
    expect(markup).toContain("Undoing…");
  });
});

describe("MemoryUpkeepRows", () => {
  const noop = () => undefined;
  it("says in one line what upkeep does and hides the tidy button while off", () => {
    const markup = render(createElement(MemoryUpkeepRows, { enabled: false, status: null, tidying: false, onToggle: noop, onTidy: noop }));
    expect(markup).toContain("Memory upkeep");
    expect(markup).toContain("About me");
    expect(markup).toContain('role="switch"');
    expect(markup).not.toContain("Tidy up now");
  });

  it("shows the last tidy-up and says when the engine cannot run the model steps", () => {
    const markup = render(createElement(MemoryUpkeepRows, {
      enabled: true,
      status: { enabled: true, modelSteps: false, lastTidy: { at: Date.now() - 60_000, expired: 1, duplicates: 2, superseded: 0, deferred: 0, contradictionsChecked: false } },
      tidying: false,
      onToggle: noop,
      onTidy: noop,
    }));
    expect(markup).toContain("Tidy up now");
    expect(markup).toContain("archived 1 expired note, merged 2 duplicates");
    expect(markup).toContain("can only archive expired notes");
    const noticed = render(createElement(MemoryUpkeepRows, { enabled: true, status: { enabled: true, modelSteps: true, lastCapture: { at: Date.now() - 60_000, added: 1, topics: 2, aboutMe: 1 } }, tidying: false, onToggle: noop, onTidy: noop }));
    expect(noticed).toContain("Last noticed 3 facts");
    expect(noticed).toContain("Not tidied yet.");
    expect(noticed).not.toContain("can only archive");
  });
});

describe("LendingReviewNotice", () => {
  const changed = ["MEMORY.md", "/srv/projects/site/CLAUDE.md"];
  it("says plainly why the bot cannot use the Mac, names what changed, and marks it reviewed in one click", () => {
    const onReviewed = vi.fn();
    const markup = render(createElement(LendingReviewNotice, { changed, stale: false, busy: false, onReviewed }));
    expect(markup).toContain("This dog's memory was changed in a conversation you didn't write, so it can't use your Mac.");
    expect(markup).toContain("Changed:");
    for (const file of changed) expect(markup).toContain(`>${file}<`);
    expect(markup).toContain(">Mark reviewed<");
    const tree = LendingReviewNotice({ changed, stale: false, busy: false, onReviewed }) as { props: { children: Array<{ type: string; props: { onClick?: () => void } }> } };
    tree.props.children.find((child) => child.type === "button")!.props.onClick!();
    expect(onReviewed).toHaveBeenCalledOnce();
  });
  it("says so when the memory changed again after the owner looked", () => {
    const markup = render(createElement(LendingReviewNotice, { changed, stale: true, busy: false, onReviewed: vi.fn() }));
    expect(markup).toContain("The memory changed again after you looked");
  });
});
