import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Group, type Message } from "@/state/store";
import * as featureFlags from "@/lib/feature-flags";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));

import { GroupView, RoomToolChip, Transcript } from "./GroupView";

const chip = (patch: Partial<Message> = {}): Message => ({
  id: "chip",
  role: "bot",
  kind: "activity",
  at: 1,
  tool: { name: "Posted in Standup", ok: true },
  ...patch,
});

const render = (message: Message) =>
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(RoomToolChip, { message })));

describe("RoomToolChip", () => {
  it("turns a linked receipt into a button that opens the room it names", () => {
    const markup = render(chip({
      comm: { groupId: "room-standup", withBotId: "scout", withName: "Standup", withColor: "green" },
    }));
    expect(markup).toContain("<button");
    expect(markup).toContain("Posted in Standup");
    expect(markup).toContain('title="Open Standup"');
  });

  it("turns an opened-thread receipt into a button that opens that thread", () => {
    const markup = render(chip({
      tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" },
    }));
    expect(markup).toContain("<button");
    expect(markup).toContain("#QA PR 245</span>");
    expect(markup).toContain("· Scout</span>");
    expect(markup).toContain('title="Open #QA PR 245 on Scout"');
  });

  it("leaves an ordinary step as a plain pill", () => {
    const markup = render(chip());
    expect(markup).not.toContain("<button");
    expect(markup).toContain("Posted in Standup");
  });

  it("shows a same-room teammate avatar without adding a navigation button", () => {
    const message = chip({
      tool: { name: "Sent to Eli", ok: true },
      comm: { groupId: "here", withBotId: "eli", withName: "Eli", withColor: "green" },
    });
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(RoomToolChip, { message, roomId: "here" })));
    expect(markup).toContain("Sent to Eli");
    expect(markup).toContain('aria-label="Eli"');
    expect(markup).not.toContain("<button");
  });
});

describe("room header", () => {
  const room: Group = {
    id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [],
    defaultResponder: { kind: "member", botId: "atlas" }, bulletin: "", unread: false,
    createdAt: 1, setupCompletedAt: 1, messages: [],
  };

  it("wraps into a name line and a control line when the column is narrow", () => {
    vi.stubGlobal("window", { laterdog: undefined });
    let markup: string;
    try {
      markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupView, { group: room })));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(markup).toContain("@container/roomhead");
    const row = /data-roomhead-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1].split(" ")).toContain("@max-3xl/roomhead:flex-wrap");
    const identity = /data-roomhead-identity="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(identity[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "@max-3xl/roomhead:basis-full"]));
    const controls = /data-roomhead-controls="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(controls[1].split(" ")).toEqual(expect.arrayContaining(["@max-3xl/roomhead:ml-auto", "@max-3xl/roomhead:flex-wrap"]));
    expect(markup).toContain("Launch planning");
  });
});


describe("opened threads in room transcripts", () => {
  const messages: Message[] = ["first", "second"].map((id, index) => ({
    id, role: "bot", kind: "activity", at: 1000 + index, turnId: "turn-a",
    tool: { name: `Opened thread #${id} on Scout`, ok: true },
    threadRef: { botId: "scout", threadId: id, title: id },
  }));
  const group: Group = {
    id: "room", threadId: "room-thread", name: "Standup", memberIds: [],
    defaultResponder: { kind: "member", botId: "scout" }, bulletin: "", unread: false,
    createdAt: 1, messages,
  };
  it("uses one opened-thread disclosure for consecutive receipts", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
      group, members: [], locale: "en", messages, transcript: messages, onReply: () => {},
    })));
    expect(markup.match(/data-opened-threads=/g)).toHaveLength(1);
    expect(markup).toContain("Opened 2 threads");
    expect(markup).toContain('aria-expanded="false"');
  });
  it.each(["reply", "run"] as const)("labels the author again when an opened-thread run is followed by its %s", (kind) => {
    const flags = vi.spyOn(featureFlags, "showToolCallsEnabled").mockReturnValue(true);
    vi.stubGlobal("window", { laterdog: undefined });
    const from = { botId: "author", name: "Author", color: "purple" as const };
    const opened = messages.map(message => ({ ...message, from }));
    const following: Message[] = kind === "reply"
      ? [{ id: "reply", role: "bot", kind: "text", text: "My follow-up reply", at: 1002, from }]
      : ["Bash", "Read"].map((name, index) => ({ id: name, role: "bot", kind: "activity", at: 1002 + index, from, tool: { name, ok: true } }));
    const sequence: Message[] = [{ id: "question", role: "user", kind: "text", text: "Please check", at: 999 }, ...opened, ...following];
    let markup: string;
    try {
      markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
        group, members: [], locale: "en", messages: sequence, transcript: sequence, onReply: () => {},
      })));
    } finally {
      flags.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(markup).toContain("Opened 2 threads");
    expect(markup.match(/aria-label="Author"/g)).toHaveLength(1);
    expect(markup.indexOf('aria-label="Author"')).toBeGreaterThan(markup.indexOf("data-opened-threads"));
    expect(markup).toContain(kind === "reply" ? "My follow-up reply" : "2 steps");
  });

  it("keeps a visible failure between two successful opens", () => {
    const failure: Message = { id: "failure", role: "bot", kind: "activity", at: 1000, tool: { name: "Could not open thread", ok: false } };
    const separated = [messages[0], failure, messages[1]];
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
      group, members: [], locale: "en", messages: separated, transcript: separated, onReply: () => {},
    })));
    expect(markup.match(/data-opened-threads=/g)).toHaveLength(2);
    expect(markup).toContain("Could not open thread");
    expect(markup).not.toContain("Opened 2 threads");
  });
});
