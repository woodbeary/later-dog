import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";

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

  it("shows an old opened-thread receipt as plain text with nothing to open", () => {
    const markup = render(chip({
      tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" },
    }));
    expect(markup).not.toContain("<button");
    expect(markup).toContain("Opened thread #QA PR 245 on Scout");
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


describe("old opened-thread rows in room transcripts", () => {
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
  it("shows each old receipt as plain text with nothing to open", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
      group, members: [], locale: "en", messages, transcript: messages, onReply: () => {},
    })));
    expect(markup.match(/data-quiet-line="note"/g)).toHaveLength(2);
    expect(markup).toContain("Opened thread #first on Scout");
    expect(markup).toContain("Opened thread #second on Scout");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Opened 2 threads");
  });
});


describe("old stored thread links in a room", () => {
  const messages: Message[] = [{
    id: "sent", role: "user", kind: "text", at: 1000,
    text: "@Scout please finish [Fix login](laterdog://thread/abc?bot=b1) first",
  }];
  const group: Group = {
    id: "room", threadId: "room-thread", name: "Standup", memberIds: [],
    defaultResponder: { kind: "member", botId: "scout" }, bulletin: "", unread: false,
    createdAt: 1, messages,
  };
  it("shows a sent message saved with a thread link as plain #Title text", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
      group, members: [], locale: "en", messages, transcript: messages, onReply: () => {},
    })));
    expect(markup).toContain("please finish #Fix login first");
    expect(markup).not.toContain("laterdog://");
    expect(markup).not.toContain("bot=b1");
  });
});

describe("a group chat without the extras", () => {
  const room: Group = {
    id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [],
    defaultResponder: { kind: "auto" }, bulletin: "Ship on Friday", unread: false,
    createdAt: 1, messages: [], pinnedMessageId: "gone", turnTimeoutMinutes: 30,
  };

  it("has no setup form, responder picker, folder, turn limit, bulletin, export, usage or call in its header", () => {
    vi.stubGlobal("window", { laterdog: undefined });
    let markup: string;
    try {
      markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupView, { group: room })));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(markup).not.toContain('data-testid="room-setup"');
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("Ship on Friday");
    expect(markup).not.toContain("data-call-button");
    expect(markup).not.toContain("Download as .md");
    expect(markup).toContain(`aria-label="Find in conversation"`);
  });

  it("shows an old fetch card as one plain line of its saved text", () => {
    const messages: Message[] = [{
      id: "goal", role: "bot", kind: "goal.run", at: 1, text: "Completed: Write the launch post",
    }];
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
      group: { ...room, messages }, members: [], locale: "en", messages, transcript: messages, onReply: () => {},
    })));
    expect(markup).toContain('data-quiet-line="note"');
    expect(markup).toContain("Completed: Write the launch post");
    expect(markup).not.toContain("coordinating");
  });

  it("has no pin on a message", () => {
    const messages: Message[] = [{ id: "m", role: "user", kind: "text", at: 1, text: "hello" }];
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
      group: { ...room, messages }, members: [], locale: "en", messages, transcript: messages, onReply: () => {},
    })));
    expect(markup).not.toContain("Pin message");
    expect(markup).toContain(`aria-label="Reply to message"`);
  });
});

describe("reactions in a group chat", () => {
  const room: Group = {
    id: "room", threadId: "room-thread", name: "Trip", memberIds: ["scout"],
    defaultResponder: { kind: "auto" }, bulletin: "", unread: false, createdAt: 1, messages: [],
  };
  const scout = { id: "scout", name: "Scout", color: "green" } as Bot;
  const messages: Message[] = [
    { id: "ask", role: "user", kind: "text", at: 1, text: "Pack light?", reactions: [{ emoji: "👍", by: "scout" }] },
    { id: "answer", role: "bot", kind: "text", at: 2, text: "Yes.", from: { botId: "scout", name: "Scout", color: "green" }, reactions: [{ emoji: "❤️", by: "user" }] },
  ];
  const draw = (readOnly = false) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(Transcript, {
    group: { ...room, messages }, members: [scout], locale: "en", messages, transcript: messages, onReply: () => {}, readOnly,
  })));

  it("shows each reaction under its bubble with who reacted, and a React button beside Reply", () => {
    const markup = draw();
    expect(markup.match(/data-testid="reaction-pills"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Scout reacted with 👍"');
    expect(markup).toContain('aria-label="You reacted with ❤️"');
    expect(markup.match(/aria-label="Add reaction"/g)).toHaveLength(2);
    expect(markup.match(/aria-label="Reply to message"/g)).toHaveLength(2);
  });

  it("shows reactions without letting a read-only viewer change them", () => {
    const markup = draw(true);
    expect(markup.match(/data-testid="reaction-pills"/g)).toHaveLength(2);
    expect(markup).not.toContain('aria-label="Add reaction"');
    expect(markup.match(/<button[^>]*disabled=""[^>]*aria-pressed/g)).toHaveLength(2);
  });
});
