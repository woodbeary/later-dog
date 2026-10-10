// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { images: true } }],
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { setLocale } = await import("@/lib/i18n");

const LIMIT_NOTICE = "A message can have up to 4 pictures.";

let host: HTMLDivElement;
let root: Root;
let thread = 0;
let uploads: string[] = [];

const picture = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
const pictures = (count: number, from = 1) => Array.from({ length: count }, (_, index) => picture(`photo-${from + index}.png`));
const pictureChips = () => host.querySelectorAll("button[aria-label^='Preview ']").length;
const pictureUploads = () => uploads.filter((url) => url.startsWith("/api/attachments?")).length;

const settle = () => act(async () => {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
});

const mount = async () => {
  thread += 1;
  const bot: Bot = {
    id: "biscuit", threadId: `thread-${thread}`, name: "Biscuit", title: "", description: "", color: "green",
    notifications: true, unread: false, messages: [], busy: false,
    modelSelection: { instanceId: "claude", model: "claude-fake" },
  };
  await act(async () => root.render(createElement(Composer, { bot })));
};

const pick = async (files: File[]) => {
  const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};

const paste = async (files: File[]) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      types: ["Files"],
      getData: () => "",
    },
  });
  await act(async () => {
    host.querySelector("textarea")!.dispatchEvent(event);
  });
  await settle();
};

const drop = async (files: File[]) => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  await act(async () => {
    window.dispatchEvent(event);
  });
  await settle();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  uploads = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    uploads.push(url);
    if (url.startsWith("/api/attachments?")) {
      return Response.json({ path: `/tmp/attachments/${uploads.length.toString(16).padStart(32, "0")}.png`, mime: "image/png", bytes: 4 });
    }
    if (url.startsWith("/api/files?")) {
      const name = new URL(url, "http://later.dog").searchParams.get("name") ?? "file";
      return Response.json({ path: `/tmp/files/${name}`, name, bytes: 4 });
    }
    return Response.json({});
  }));
  setLocale("en");
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("four pictures to a message", () => {
  it("adds the first four of six picked pictures and says why", async () => {
    await mount();
    await pick(pictures(6));
    expect(pictureChips()).toBe(4);
    expect(pictureUploads()).toBe(4);
    expect(host.textContent).toContain(LIMIT_NOTICE);
  });

  it("counts the pictures already in the message, however they arrived", async () => {
    await mount();
    await pick(pictures(3));
    expect(pictureChips()).toBe(3);
    expect(host.textContent).not.toContain(LIMIT_NOTICE);

    await paste(pictures(2, 4));
    expect(pictureChips()).toBe(4);
    expect(host.textContent).toContain(LIMIT_NOTICE);

    await drop(pictures(1, 6));
    expect(pictureChips()).toBe(4);
    expect(pictureUploads()).toBe(4);
  });

  it("still takes documents once the pictures are full", async () => {
    await mount();
    await pick([...pictures(5), new File(["notes"], "notes.md", { type: "text/markdown" })]);
    expect(pictureChips()).toBe(4);
    expect(host.textContent).toContain("notes.md");
    expect(uploads.filter((url) => url.startsWith("/api/files?"))).toHaveLength(1);
  });

  it("makes room again when a picture is removed", async () => {
    await mount();
    await pick(pictures(4));
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='Remove file']")!.click());
    expect(pictureChips()).toBe(3);
    await pick(pictures(1, 5));
    expect(pictureChips()).toBe(4);
    expect(host.textContent).not.toContain(LIMIT_NOTICE);
  });
});
