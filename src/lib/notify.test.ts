import { afterEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ enabled: true }));
vi.mock("./notification-preferences", () => ({
  notificationSoundsEnabled: () => sounds.enabled,
}));

import { replyable } from "../../shared/notification";
import {
  buildNotificationOptions,
  desktopBanners,
  requestNotificationPermission,
  showNotification,
  type NotifyFrame,
} from "./notify";

const frame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Dog",
  threadId: "thread-1",
  title: "Dog finished",
  body: "All done",
};

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sounds.enabled = true;
});

describe("desktop notifications", () => {
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `laterdog:${frame.botId}` } });
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("shows a spend notice even over the thread it points at, in its own stack", () => {
    const { notices } = installNotification("granted", true);

    showNotification({ ...frame, kind: "spend", title: "Monthly spend limit reached" }, vi.fn(), "https://avatar.test/a.png", frame.threadId);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.options).toMatchObject({ tag: "laterdog:spend", icon: undefined });
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, "another-thread");

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
    );

    expect(notices[0]?.options?.tag).toBe(`laterdog:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`laterdog:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2" }, vi.fn());
    expect(notices[2]?.options?.tag).toBe(`laterdog:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification(frame, vi.fn(), null);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });
});

describe("notification sounds", () => {
  it("lets the platform play its sound by default", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices[0]?.options?.silent).toBeUndefined();
  });

  it("posts silently when sounds are muted on this computer, keeping the banner", () => {
    sounds.enabled = false;
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]?.options).toMatchObject({ body: frame.body, silent: true });
  });
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "laterdog:bot-9",
      icon: undefined,
    });
  });
});

describe("native banners in the desktop app", () => {
  function installBridge(focused = false) {
    const show = vi.fn();
    const { notices, requestPermission } = installNotification("granted", focused);
    vi.stubGlobal("window", { focus: vi.fn(), laterdog: { notifications: { show, onOpen: vi.fn(), onReply: vi.fn() } } });
    return { show, notices, requestPermission };
  }

  it("hands the frame to the native bridge instead of a web notification", () => {
    const { show, notices } = installBridge();
    showNotification({ ...frame, groupId: "group-1" }, vi.fn());
    expect(notices).toHaveLength(0);
    expect(show).toHaveBeenCalledWith({
      kind: "done",
      botId: "bot-1",
      threadId: "thread-1",
      groupId: "group-1",
      title: frame.title,
      body: frame.body,
      silent: false,
      replyable: true,
    });
  });

  it("marks approvals and takeovers not replyable and follows the sounds switch", () => {
    sounds.enabled = false;
    const { show } = installBridge();
    showNotification({ ...frame, kind: "approval" }, vi.fn());
    showNotification({ ...frame, kind: "takeover" }, vi.fn());
    expect(show.mock.calls.map(([request]) => [request.replyable, request.silent])).toEqual([[false, true], [false, true]]);
  });

  it("stays quiet over the visible thread and never asks the web permission", async () => {
    const { show, requestPermission } = installBridge(true);
    showNotification(frame, vi.fn(), undefined, frame.threadId);
    expect(show).not.toHaveBeenCalled();
    expect(requestNotificationPermission()).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(desktopBanners()).not.toBeNull();
  });
});

describe("replyable", () => {
  it("lets every kind but approvals and takeovers take a reply", () => {
    expect(replyable("done")).toBe(true);
    expect(replyable("question")).toBe(true);
    expect(replyable("approval")).toBe(false);
    expect(replyable("takeover")).toBe(false);
  });
});
