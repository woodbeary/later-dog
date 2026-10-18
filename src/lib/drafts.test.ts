import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const effects = vi.hoisted(() => [] as EffectCallback[]);
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback) => { effects.push(effect); },
}));

import {
  appendComposerDraft,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  clampDraftPosition,
  draftRevision,
  failedComposerSends,
  getDraft,
  getDraftAttachments,
  getDraftPosition,
  isDraftAttachmentPending,
  markDraftEdited,
  placeDraftPosition,
  recoverFailedComposerSend,
  replaceDraftAttachment,
  restoredSendId,
  setDraft,
  setDraftAttachments,
  setDraftPosition,
  useDraft,
} from "./drafts";
import { citationAttachment, createCitationTextSelector } from "./citations";
import { composeMessage } from "./composer-attachments";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

const page = vi.hoisted(() => {
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  return page;
});
const leavePage = () => page.dispatchEvent(new Event("pagehide"));
afterAll(() => { vi.unstubAllGlobals(); });

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

function copyStorage(store: Storage): Storage {
  const copy = memoryStorage();
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)!;
    copy.setItem(key, store.getItem(key)!);
  }
  return copy;
}

describe("failed send recovery", () => {
  it("restores a failed send after its original composer unmounted", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:failed-send:task";
    setDraft(store, draftId, "Finish the release");
    const sent = {
      draftId,
      revision: draftRevision(draftId),
      sendId: "failed-send",
      threadId: "task",
      text: "Finish the release",
      requestText: "Finish the release",
      attachments: [],
    };
    setDraft(store, draftId, "");

    expect(recoverFailedComposerSend(sent)).toBe("restored");
    expect(getDraft(store, draftId)).toBe(sent.text);
    expect(restoredSendId(draftId)).toBe(sent.sendId);
  });

  it("keeps a newer draft when an older send fails", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:older-send:task";
    const revision = draftRevision(draftId);
    markDraftEdited(draftId);
    setDraft(store, draftId, "Just discuss it first");

    expect(recoverFailedComposerSend({
      draftId,
      revision,
      sendId: "older-send",
      threadId: "task",
      text: "Finish the release",
      requestText: "Finish the release",
      attachments: [],
    })).toBe("outbox");
    expect(getDraft(store, draftId)).toBe("Just discuss it first");
    expect(failedComposerSends(draftId)).toEqual([
      expect.objectContaining({ sendId: "older-send" }),
    ]);
  });
});

describe("durable attachment completion", () => {
  it("isolates persisted citation drafts and keeps an older failed citation send out of a newer draft", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:citations:thread-a";
    const otherDraftId = "bot:citations:thread-b";
    const citation = citationAttachment(
      { ownerType: "bot", ownerId: "citations", threadId: "thread-a", messageId: "source-1" },
      createCitationTextSelector("before selected after", 7, 15)!,
      "old note",
    );
    setDraftAttachments(store, draftId, [citation]);
    expect(getDraftAttachments(store, draftId)).toEqual([citation]);
    expect(getDraftAttachments(store, otherDraftId)).toEqual([]);

    const revision = draftRevision(draftId);
    markDraftEdited(draftId);
    setDraft(store, draftId, "newer words");
    setDraftAttachments(store, draftId, []);
    expect(recoverFailedComposerSend({
      draftId,
      revision,
      sendId: "citation-send",
      threadId: "thread-a",
      text: "",
      requestText: composeMessage("", [citation]),
      attachments: [citation],
    })).toBe("outbox");
    expect(getDraft(store, draftId)).toBe("newer words");
    expect(getDraftAttachments(store, draftId)).toEqual([]);
    expect(failedComposerSends(draftId)).toEqual([expect.objectContaining({ sendId: "citation-send" })]);
  });

  it("keeps blob previews in memory but never writes them into durable storage", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:preview:thread-preview";
    setDraftAttachments(store, draftId, [
      {
        kind: "image",
        id: "uploading",
        path: "",
        name: "uploading.png",
        size: 3,
        mime: "image/png",
        previewUrl: "blob:uploading",
        uploading: true,
      },
      {
        kind: "image",
        id: "ready",
        path: "/private/attachments/ready.png",
        name: "ready.png",
        size: 4,
        mime: "image/png",
        previewUrl: "blob:ready",
      },
    ]);

    expect(getDraftAttachments(store, draftId)).toHaveLength(2);
    expect(JSON.parse(store.getItem("laterdog-draft-attachments") ?? "{}")[draftId]).toEqual([
      {
        kind: "image",
        id: "ready",
        path: "/private/attachments/ready.png",
        name: "ready.png",
        size: 4,
        mime: "image/png",
      },
    ]);
  });

  it("replaces a pending image after navigation without appending a duplicate", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:replace:thread-replace";
    setDraftAttachments(store, draftId, [{
      kind: "image",
      id: "same-image",
      path: "",
      name: "photo.png",
      size: 3,
      mime: "image/png",
      previewUrl: "blob:photo",
      uploading: true,
    }]);

    expect(replaceDraftAttachment(draftId, "same-image", {
      kind: "image",
      id: "same-image",
      path: "/private/attachments/photo.png",
      name: "photo.png",
      size: 3,
      mime: "image/png",
      previewUrl: "blob:photo",
    })).toBe(true);
    expect(getDraftAttachments(store, draftId)).toEqual([
      expect.objectContaining({ id: "same-image", path: "/private/attachments/photo.png" }),
    ]);
    expect(replaceDraftAttachment(draftId, "missing", null)).toBe(false);
  });

  it("appends to the keyed draft without a mounted React state updater", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    appendDraftAttachments("bot:a:thread-a", [{
      kind: "file",
      id: "file-1",
      path: "/private/attachments/file.pdf",
      name: "file.pdf",
      size: 42,
    }]);
    expect(getDraftAttachments(store, "bot:a:thread-a")).toHaveLength(1);
    expect(getDraftAttachments(store, "bot:b:thread-b")).toEqual([]);
  });

  it("merges with the live in-memory draft when storage rejects writes", () => {
    const readable = memoryStorage();
    const store: Storage = {
      ...readable,
      setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:quota:thread-quota";
    setDraft(store, draftId, "keep this text");
    setDraftAttachments(store, draftId, [{
      kind: "file",
      id: "existing",
      path: "/private/attachments/existing.pdf",
      name: "existing.pdf",
      size: 10,
    }]);

    appendDraftAttachments(draftId, [{
      kind: "file",
      id: "late",
      path: "/private/attachments/late.pdf",
      name: "late.pdf",
      size: 20,
    }]);

    expect(getDraft(store, draftId)).toBe("keep this text");
    expect(getDraftAttachments(store, draftId).map((attachment) => attachment.id))
      .toEqual(["existing", "late"]);
  });

  it("keeps concurrent pending uploads scoped to their originating draft", () => {
    changeDraftAttachmentPending("bot:pending:a", true);
    changeDraftAttachmentPending("bot:pending:a", true);
    changeDraftAttachmentPending("bot:pending:b", true);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(true);
    expect(isDraftAttachmentPending("bot:pending:b")).toBe(true);

    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:b", false);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(false);
    expect(isDraftAttachmentPending("bot:pending:b")).toBe(false);

    changeDraftAttachmentPending("bot:pending:a", true);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(true);
    changeDraftAttachmentPending("bot:pending:a", false);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(false);
  });
});

describe("appendComposerDraft", () => {
  const prompt = "Create a verification skill from the run below.\n\n✓ doctor — pnpm control:laterdog doctor\n\n";

  it("puts the text into an empty draft exactly as given", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:save:thread-empty";
    const revision = draftRevision(draftId);
    appendComposerDraft(draftId, prompt);
    expect(getDraft(store, draftId)).toBe(prompt);
    leavePage();
    expect(JSON.parse(store.getItem("laterdog-drafts") ?? "{}")[draftId]).toBe(prompt);
    expect(draftRevision(draftId)).toBe(revision + 1);
  });

  it("appends after a blank line and never replaces what the person typed", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:save:thread-typed";
    setDraft(store, draftId, "Keep the doctor step first.");
    appendComposerDraft(draftId, prompt);
    expect(getDraft(store, draftId)).toBe(`Keep the doctor step first.\n\n${prompt}`);
  });

  it("leaves attachments as they were", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:save:thread-attached";
    const attachment = { kind: "file" as const, id: "file-1", path: "/private/attachments/log.txt", name: "log.txt", size: 12 };
    setDraftAttachments(store, draftId, [attachment]);
    appendComposerDraft(draftId, prompt);
    expect(getDraft(store, draftId)).toBe(prompt);
    expect(getDraftAttachments(store, draftId)).toEqual([attachment]);
  });
});

describe("saving typed drafts", () => {
  function countedStorage() {
    const store = memoryStorage();
    const writes: string[] = [];
    const counted: Storage = {
      ...store,
      key: store.key,
      get length() { return store.length; },
      setItem: (key, value) => {
        if (key === "laterdog-drafts") writes.push(value);
        store.setItem(key, value);
      },
    };
    return { store: counted, writes };
  }

  function mountDraft(id: string) {
    effects.length = 0;
    let setText: (next: string) => void = () => {};
    function Draft() {
      [, setText] = useDraft(id);
      return null;
    }
    renderToStaticMarkup(createElement(Draft));
    const cleanups = effects.map((effect) => effect());
    return {
      type: (text: string) => setText(text),
      unmount: () => { for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup(); },
    };
  }

  beforeEach(() => {
    leavePage();
    vi.useFakeTimers();
  });
  afterEach(() => {
    leavePage();
    vi.useRealTimers();
  });

  it("writes storage once when typing pauses, not on every keystroke", () => {
    const { store, writes } = countedStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:typing:thread";
    const composer = mountDraft(draftId);
    let text = "";
    for (let key = 0; key < 20; key += 1) {
      text += "x";
      composer.type(text);
      vi.advanceTimersByTime(100);
    }
    expect(writes).toHaveLength(0);
    expect(getDraft(store, draftId)).toBe(text);

    vi.advanceTimersByTime(400);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])[draftId]).toBe(text);
    expect(getDraft(copyStorage(store), draftId)).toBe(text);
    composer.unmount();
  });

  it("saves at once when the window loses focus or the page closes, and only what changed", () => {
    for (const event of ["blur", "pagehide"]) {
      const { store, writes } = countedStorage();
      const draftId = `bot:${event}:thread`;
      setDraft(store, draftId, "half a thought");
      page.dispatchEvent(new Event(event));
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])[draftId]).toBe("half a thought");
      vi.advanceTimersByTime(1_000);
      page.dispatchEvent(new Event(event));
      expect(writes).toHaveLength(1);
    }
  });

  it("saves at once when the composer switches to another thread", () => {
    const { store, writes } = countedStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const composer = mountDraft("bot:switch:thread-a");
    composer.type("for thread a");
    expect(writes).toHaveLength(0);
    composer.unmount();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])["bot:switch:thread-a"]).toBe("for thread a");
  });

  it("keeps a draft unsaved after a failed write and saves it on the next try", () => {
    const { store, writes } = countedStorage();
    const accepting = store.setItem;
    let full = true;
    store.setItem = (key, value) => {
      if (full) throw new DOMException("quota exceeded", "QuotaExceededError");
      accepting(key, value);
    };
    setDraft(store, "bot:quota-retry:thread", "still on screen");
    leavePage();
    expect(writes).toHaveLength(0);
    full = false;
    page.dispatchEvent(new Event("blur"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])["bot:quota-retry:thread"]).toBe("still on screen");
  });

  it("keeps drafts another window saved and drops an emptied one", () => {
    const { store, writes } = countedStorage();
    store.setItem("laterdog-drafts", JSON.stringify({ "bot:other-window:thread": "theirs", "bot:sent:thread": "old" }));
    writes.length = 0;
    setDraft(store, "bot:sent:thread", "");
    leavePage();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({ "bot:other-window:thread": "theirs" });
  });
});

describe("keeping the composer's place in a long draft", () => {
  afterEach(() => leavePage());

  it("remembers the caret and scroll for each draft and brings them back after a restart", () => {
    const store = memoryStorage();
    const draftId = "bot:place:thread-a";
    setDraft(store, draftId, "a long message\n".repeat(40));
    setDraftPosition(store, draftId, { start: 120, end: 132, scrollTop: 240.5 });
    expect(getDraftPosition(store, draftId)).toEqual({ start: 120, end: 132, scrollTop: 240.5 });
    expect(getDraftPosition(store, "bot:place:thread-b")).toBeNull();

    leavePage();
    const restarted = copyStorage(store);
    expect(getDraftPosition(restarted, draftId)).toEqual({ start: 120, end: 132, scrollTop: 240.5 });
    expect(getDraftPosition(restarted, "bot:place:thread-b")).toBeNull();
  });

  it("keeps a saved draft when only its place changed", () => {
    const store = memoryStorage();
    const draftId = "bot:place:saved-earlier";
    store.setItem("laterdog-drafts", JSON.stringify({ [draftId]: "written in an earlier session" }));
    setDraftPosition(store, draftId, { start: 4, end: 4, scrollTop: 0 });
    leavePage();
    expect(JSON.parse(store.getItem("laterdog-drafts")!)[draftId]).toBe("written in an earlier session");
    expect(JSON.parse(store.getItem("laterdog-draft-positions")!)[draftId]).toEqual({ start: 4, end: 4, scrollTop: 0 });
  });

  it("forgets the place once the draft is sent", () => {
    const store = memoryStorage();
    const draftId = "bot:place:sent";
    setDraft(store, draftId, "about to send");
    setDraftPosition(store, draftId, { start: 5, end: 5, scrollTop: 0 });
    leavePage();
    setDraft(store, draftId, "");
    leavePage();
    expect(JSON.parse(store.getItem("laterdog-draft-positions")!)).toEqual({});
  });

  it("drops the place when text is put in the draft for the person, so the caret goes to the end", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:place:filled";
    setDraft(store, draftId, "first part");
    setDraftPosition(store, draftId, { start: 2, end: 2, scrollTop: 0 });
    appendComposerDraft(draftId, "added by a button");
    expect(getDraftPosition(store, draftId)).toBeNull();
    leavePage();
    expect(JSON.parse(store.getItem("laterdog-draft-positions")!)[draftId]).toBeUndefined();
  });

  it("ignores places that are not whole, ordered offsets", () => {
    const store = memoryStorage();
    store.setItem("laterdog-draft-positions", JSON.stringify({
      negative: { start: -1, end: 2, scrollTop: 0 },
      backwards: { start: 5, end: 2, scrollTop: 0 },
      fraction: { start: 1.5, end: 2, scrollTop: 0 },
      text: { start: 1, end: 2, scrollTop: "9" },
      word: "middle",
    }));
    for (const id of ["negative", "backwards", "fraction", "text", "word"]) expect(getDraftPosition(store, id)).toBeNull();
    setDraftPosition(store, "set-backwards", { start: 9, end: 3, scrollTop: 0 });
    expect(getDraftPosition(store, "set-backwards")).toBeNull();
  });

  it("clamps a remembered place to the text that is there now", () => {
    expect(clampDraftPosition({ start: 50, end: 80, scrollTop: 10 }, 60)).toEqual({ start: 50, end: 60, scrollTop: 10 });
    expect(clampDraftPosition({ start: 70, end: 80, scrollTop: 10 }, 60)).toEqual({ start: 60, end: 60, scrollTop: 10 });
    expect(clampDraftPosition({ start: 3, end: 7, scrollTop: 0 }, 60)).toEqual({ start: 3, end: 7, scrollTop: 0 });
    const selections: [number, number][] = [];
    const input = {
      value: "short now",
      scrollTop: 0,
      setSelectionRange: (start: number, end: number) => { selections.push([start, end]); },
    };
    placeDraftPosition(input, { start: 4, end: 400, scrollTop: 320 });
    expect(selections).toEqual([[4, 9]]);
    expect(input.scrollTop).toBe(320);
  });
});
