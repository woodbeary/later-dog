import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  NOTIFICATION_OPEN_CHANNEL,
  NOTIFICATION_REPLY_CHANNEL,
  bannerRequest,
  createDesktopNotifications,
  hideOnClose,
} from "./desktop-notifications.mjs";

function fakeNotificationClass({ supported = true } = {}) {
  const shown = [];
  class FakeNotification extends EventEmitter {
    static isSupported = () => supported;
    constructor(options) {
      super();
      this.options = options;
    }
    show() {
      shown.push(this);
    }
  }
  return { FakeNotification, shown };
}

function harness({ platform = "darwin", supported } = {}) {
  const { FakeNotification, shown } = fakeNotificationClass({ supported });
  const opened = [];
  const delivered = [];
  let ids = 0;
  const banners = createDesktopNotifications({
    Notification: FakeNotification,
    platform,
    open: (channel, target) => opened.push([channel, target]),
    deliver: (channel, reply) => delivered.push([channel, reply]),
    newSendId: () => `send-${++ids}`,
  });
  return { banners, shown, opened, delivered };
}

const done = {
  kind: "done",
  botId: "bot-1",
  threadId: "thread-1",
  title: "Rex finished",
  body: "The report is ready",
  silent: false,
  replyable: true,
};

test("a replyable banner on macOS offers Reply and groups under its dog", () => {
  const { banners, shown } = harness();
  assert.equal(banners.show(done), true);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].options, {
    id: "laterdog:bot-1",
    groupId: "bot-1",
    title: "Rex finished",
    body: "The report is ready",
    silent: false,
    hasReply: true,
    replyPlaceholder: "Reply",
  });
});

test("clicking a banner opens the dog it names", () => {
  const { banners, shown, opened, delivered } = harness();
  banners.show(done);
  shown[0].emit("click");
  assert.deepEqual(opened, [[NOTIFICATION_OPEN_CHANNEL, { botId: "bot-1", threadId: "thread-1" }]]);
  assert.deepEqual(delivered, []);
  assert.equal(banners.liveCount(), 0);
});

test("a banner Reply is delivered once with a fresh sendId and never opens the window", () => {
  const { banners, shown, opened, delivered } = harness();
  banners.show(done);
  shown[0].emit("reply", { reply: "Send it to Sam" }, "Send it to Sam");
  banners.show(done);
  shown[1].emit("reply", { reply: "And copy me" });
  assert.deepEqual(opened, []);
  assert.deepEqual(delivered, [
    [NOTIFICATION_REPLY_CHANNEL, { botId: "bot-1", threadId: "thread-1", text: "Send it to Sam", sendId: "send-1" }],
    [NOTIFICATION_REPLY_CHANNEL, { botId: "bot-1", threadId: "thread-1", text: "And copy me", sendId: "send-2" }],
  ]);
});

test("the older reply string still works and a blank reply sends nothing", () => {
  const { banners, shown, delivered } = harness();
  banners.show(done);
  shown[0].emit("reply", {}, "Legacy text");
  banners.show(done);
  shown[1].emit("reply", { reply: "   " });
  assert.deepEqual(delivered.map(([, reply]) => reply.text), ["Legacy text"]);
});

test("a group banner carries its group so Reply goes to the group chat", () => {
  const { banners, shown, delivered } = harness();
  banners.show({ ...done, groupId: "group-1", threadId: "room-thread", title: "Rex in Launch finished" });
  assert.equal(shown[0].options.id, "laterdog:group-1");
  assert.equal(shown[0].options.groupId, "group-1");
  shown[0].emit("reply", { reply: "Ship it" });
  assert.deepEqual(delivered[0][1], { botId: "bot-1", threadId: "room-thread", groupId: "group-1", text: "Ship it", sendId: "send-1" });
});

test("approvals and other kinds the renderer marks not replyable get no Reply field", () => {
  const { banners, shown, delivered } = harness();
  banners.show({ ...done, kind: "approval", replyable: false });
  assert.equal(shown[0].options.hasReply, undefined);
  shown[0].emit("reply", { reply: "ignored" });
  assert.deepEqual(delivered, []);
});

test("Reply is offered only on macOS; elsewhere a click still opens the dog", () => {
  const { banners, shown, opened } = harness({ platform: "win32" });
  banners.show(done);
  assert.equal(shown[0].options.hasReply, undefined);
  shown[0].emit("click");
  assert.equal(opened.length, 1);
});

test("spend notices share one banner slot and muted sounds post silently", () => {
  const { banners, shown } = harness();
  banners.show({ ...done, kind: "spend", silent: true });
  assert.equal(shown[0].options.id, "laterdog:spend");
  assert.equal(shown[0].options.silent, true);
});

test("malformed requests from the page show nothing", () => {
  const { banners, shown } = harness();
  for (const bad of [null, "x", {}, { ...done, botId: "../x" }, { ...done, threadId: 5 }, { ...done, title: "  " }, { ...done, groupId: "a b" }]) {
    assert.equal(banners.show(bad), false);
  }
  assert.equal(shown.length, 0);
  assert.equal(bannerRequest({ ...done, title: "t".repeat(500), body: "b".repeat(5_000) }).title.length, 200);
  assert.equal(bannerRequest({ ...done, body: "b".repeat(5_000) }).body.length, 1_000);
});

test("nothing is shown where the system has no notifications", () => {
  const { banners, shown } = harness({ supported: false });
  assert.equal(banners.show(done), false);
  assert.equal(shown.length, 0);
});

test("a replaced banner keeps only the newest live, and closing it forgets it", () => {
  const { banners, shown } = harness();
  banners.show(done);
  banners.show({ ...done, body: "Second" });
  assert.equal(banners.liveCount(), 1);
  shown[0].emit("close");
  assert.equal(banners.liveCount(), 1);
  shown[1].emit("close");
  assert.equal(banners.liveCount(), 0);
});

function fakeWindow({ fullScreen = false } = {}) {
  const win = new EventEmitter();
  win.hidden = 0;
  win.fullScreen = fullScreen;
  win.hide = () => { win.hidden += 1; };
  win.isFullScreen = () => win.fullScreen;
  win.setFullScreen = (value) => {
    win.fullScreen = value;
    if (!value) queueMicrotask(() => win.emit("leave-full-screen"));
  };
  const close = () => {
    let prevented = false;
    win.emit("close", { preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { win, close };
}

test("on macOS closing the window hides it so live events and banners keep running", () => {
  const { win, close } = fakeWindow();
  hideOnClose(win, { platform: "darwin", quitting: () => false });
  assert.equal(close(), true);
  assert.equal(win.hidden, 1);
});

test("quitting still closes the window on macOS", () => {
  const { win, close } = fakeWindow();
  let quitting = false;
  hideOnClose(win, { platform: "darwin", quitting: () => quitting });
  quitting = true;
  assert.equal(close(), false);
  assert.equal(win.hidden, 0);
});

test("a full-screen window leaves full screen before it hides", async () => {
  const { win, close } = fakeWindow({ fullScreen: true });
  hideOnClose(win, { platform: "darwin", quitting: () => false });
  assert.equal(close(), true);
  assert.equal(win.hidden, 0);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(win.fullScreen, false);
  assert.equal(win.hidden, 1);
});

test("other systems keep their own close behaviour", () => {
  for (const platform of ["win32", "linux"]) {
    const { win, close } = fakeWindow();
    hideOnClose(win, { platform, quitting: () => false });
    assert.equal(close(), false);
    assert.equal(win.hidden, 0);
  }
});
