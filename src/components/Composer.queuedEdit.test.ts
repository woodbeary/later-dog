// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  queues: {} as Record<string, Array<{ queueId: string; text: string }>>,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        pendingQueued: fixture.queues,
        instances: [{ instanceId: "codex", driverKind: "codex", displayName: "Codex", capabilities: { queueing: true, images: true } }],
      },
      dispatch: fixture.dispatch,
    }),
  };
});

const { Composer } = await import("./Composer");
const { appendComposerDraft, appendDraftAttachments, draftAttachments } = await import("@/lib/drafts");
const { composeMessage } = await import("@/lib/composer-attachments");
const { setLocale } = await import("@/lib/i18n");

const cloudPicture = "/data/.laterdog/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png";
const macPicture = "/Users/jacob/.laterdog/attachments/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg";
const screenshot = "Screenshot 2026-10-15 at 1.53.02 PM.png";
const jacobsQueued = `look at this\n\n<attached-image path="${cloudPicture}" name="${screenshot}" />`;

let host: HTMLDivElement;
let root: Root;
let sequence = 0;

const bot = (threadId: string): Bot => ({
  id: "biscuit", threadId, name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy: true,
  modelSelection: { instanceId: "codex", model: "codex-fake" },
});
const room = (threadId: string): Group => ({
  id: "room", threadId, name: "Room", memberIds: ["biscuit"], defaultResponder: { kind: "member", botId: "biscuit" },
  bulletin: "", unread: false, createdAt: 1, messages: [], working: true, busyBotId: "biscuit",
});
const nextThread = () => `queued-edit-${++sequence}`;
const showBot = async (threadId: string) => {
  await act(async () => root.render(createElement(Composer, { bot: bot(threadId) })));
};
const showRoom = async (threadId: string) => {
  await act(async () => root.render(createElement(Composer, { group: room(threadId), members: [bot(threadId)] })));
};
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action);
const edit = async (cancelType: "cancelQueued" | "cancelGroupQueued") => {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label^="Edit queued message"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  const cancel = actions().find((action) => action.type === cancelType);
  expect(cancel).toBeDefined();
  return cancel;
};
const composerText = () => host.querySelector("textarea")!.value;
const thumbnails = () => [...host.querySelectorAll<HTMLImageElement>("[data-composer-attachments] img")];
const pressEnter = async () => {
  await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
};
const tagCount = (text: string) => text.match(/<attached-image/g)?.length ?? 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.queues = {};
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("editing a queued message with a picture", () => {
  it("shows a dog's queued screenshot as a thumbnail and sends it once", async () => {
    const threadId = nextThread();
    fixture.queues[threadId] = [{ queueId: "q1", text: jacobsQueued }];
    await showBot(threadId);
    const cancel = await edit("cancelQueued");
    expect(cancel).toMatchObject({ botId: "biscuit", threadId, queueId: "q1" });
    expect(composerText()).toBe("");
    expect(thumbnails()).toHaveLength(0);

    await act(async () => cancel.onCancelled());
    expect(composerText()).toBe("look at this");
    expect(composerText()).not.toContain("<attached-image");
    expect(thumbnails()).toHaveLength(1);
    expect(thumbnails()[0]!.alt).toBe(screenshot);
    expect(thumbnails()[0]!.getAttribute("src")).toBe("/api/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png");

    await pressEnter();
    const send = actions().find((action) => action.type === "send");
    expect(send.text).toBe(jacobsQueued);
    expect(tagCount(send.text)).toBe(1);
  });

  it("does the same for a room's queued message", async () => {
    const threadId = nextThread();
    fixture.queues[threadId] = [{ queueId: "rq1", text: jacobsQueued }];
    await showRoom(threadId);
    const cancel = await edit("cancelGroupQueued");
    expect(cancel).toMatchObject({ groupId: "room", threadId, queueId: "rq1" });

    await act(async () => cancel.onCancelled());
    expect(composerText()).toBe("look at this");
    expect(thumbnails().map((image) => image.alt)).toEqual([screenshot]);

    await pressEnter();
    const send = actions().find((action) => action.type === "sendGroup");
    expect(send.text).toBe(jacobsQueued);
    expect(tagCount(send.text)).toBe(1);
  });

  it("keeps several pictures from both the Mac and the Cloud home", async () => {
    const threadId = nextThread();
    const queued = composeMessage("two of them", [
      { kind: "image", id: "a", path: cloudPicture, name: "cloud.png", size: 1, mime: "image/png" },
      { kind: "image", id: "b", path: macPicture, name: "mac.jpg", size: 1, mime: "image/jpeg" },
    ]);
    fixture.queues[threadId] = [{ queueId: "q2", text: queued }];
    await showBot(threadId);
    const cancel = await edit("cancelQueued");
    await act(async () => cancel.onCancelled());
    expect(composerText()).toBe("two of them");
    expect(thumbnails().map((image) => image.getAttribute("src"))).toEqual([
      "/api/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png",
      "/api/attachments/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg",
    ]);

    await pressEnter();
    const send = actions().find((action) => action.type === "send");
    expect(send.text).toBe(queued);
    expect(tagCount(send.text)).toBe(2);
  });

  it("keeps the current draft and its attachments, adding the picture once", async () => {
    const threadId = nextThread();
    const draftId = `bot:biscuit:${threadId}`;
    fixture.queues[threadId] = [{ queueId: "q3", text: jacobsQueued }];
    appendComposerDraft(draftId, "and my next thought");
    appendDraftAttachments(draftId, [
      { kind: "file", id: "existing-file", path: "/tmp/notes.pdf", name: "notes.pdf", size: 42 },
      { kind: "image", id: "same-picture", path: cloudPicture, name: screenshot, size: 42, mime: "image/png" },
    ]);
    await showBot(threadId);
    const cancel = await edit("cancelQueued");
    await act(async () => cancel.onCancelled());
    expect(composerText()).toBe("look at this\n\nand my next thought");
    expect(draftAttachments(draftId)).toEqual([
      expect.objectContaining({ kind: "file", id: "existing-file" }),
      expect.objectContaining({ kind: "image", id: "same-picture" }),
    ]);
    expect(thumbnails()).toHaveLength(1);
  });

  it("leaves text that only mentions the tag as words", async () => {
    const threadId = nextThread();
    const queued = [
      "what is this line in my message?",
      "",
      `<attached-image path="/Users/jacob/Desktop/cat.png" name="cat.png" />`,
      "",
      `and inline <attached-image path="${cloudPicture}" /> too`,
    ].join("\n");
    fixture.queues[threadId] = [{ queueId: "q4", text: queued }];
    await showBot(threadId);
    const cancel = await edit("cancelQueued");
    await act(async () => cancel.onCancelled());
    expect(composerText()).toBe(queued);
    expect(thumbnails()).toHaveLength(0);
  });

  it("restores into the original conversation when cancelling finishes after a switch", async () => {
    const threadId = nextThread();
    const other = nextThread();
    fixture.queues[threadId] = [{ queueId: "q5", text: jacobsQueued }];
    await showBot(threadId);
    const cancel = await edit("cancelQueued");
    appendComposerDraft(`bot:biscuit:${other}`, "separate conversation");
    await showBot(other);
    await act(async () => cancel.onCancelled());
    expect(composerText()).toBe("separate conversation");
    expect(draftAttachments(`bot:biscuit:${other}`)).toEqual([]);
    await showBot(threadId);
    expect(composerText()).toBe("look at this");
    expect(thumbnails()).toHaveLength(1);
  });
});
