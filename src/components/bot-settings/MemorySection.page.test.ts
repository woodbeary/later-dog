// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCapacity, MemoryOverview } from "@/lib/memory";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  docs: new Map<string, { text: string; hash: string }>(),
  overview: null as unknown,
  saves: [] as Array<{ path: string; text: string; expectedHash: string | undefined }>,
  deletes: [] as string[],
  opened: [] as string[],
  fetched: [] as string[],
  conflict: null as string | null,
  confirm: vi.fn(() => true),
  dispatch: vi.fn(),
}));

vi.mock("@/lib/memory", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory")>(),
  fetchMemoryOverview: vi.fn(async () => fixture.overview),
  fetchMemoryJournal: vi.fn(async () => []),
  fetchUpkeepStatus: vi.fn(async () => ({ enabled: true, modelSteps: true })),
  fetchMemoryDoc: vi.fn(async (_botId: string, path: string) => {
    fixture.fetched.push(path);
    const doc = fixture.docs.get(path);
    return doc ? { path, ...doc, exists: true } : { path, text: "", hash: "empty", exists: false };
  }),
  saveMemoryDoc: vi.fn(async (_botId: string, path: string, text: string, expectedHash: string | undefined) => {
    fixture.saves.push({ path, text, expectedHash });
    if (fixture.conflict !== null && expectedHash !== "theirs") return { ok: false, conflict: true, current: fixture.conflict, currentHash: "theirs" };
    const hash = `saved-${fixture.saves.length}`;
    fixture.docs.set(path, { text, hash });
    return { ok: true, doc: { path, text, hash, exists: true }, overview: fixture.overview };
  }),
  deleteMemoryDoc: vi.fn(async (_botId: string, path: string) => {
    fixture.deletes.push(path);
    fixture.docs.delete(path);
    return { overview: fixture.overview };
  }),
  openMemoryLocation: vi.fn(async (_botId: string, target: string) => {
    fixture.opened.push(target);
    return { ok: true, workspacePath: "/w" };
  }),
}));
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "darwin" } } }),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
}));

const { MemorySection, topicTemplate } = await import("./MemorySection");

const bot = { id: "scout", name: "Scout", memoryEnabled: true, memoryUpkeep: true, busy: false } as unknown as Bot;
const capacity = (patch: Partial<MemoryCapacity> = {}): MemoryCapacity => ({
  lines: 3, bytes: 60, maxLines: 200, maxBytes: 24_000, loadedLines: 3, loadedBytes: 60, truncated: false, hash: "main", ...patch,
});
const overview = (patch: Partial<MemoryOverview> = {}): MemoryOverview => ({
  botId: "scout",
  workspacePath: "/Users/me/.laterdog/workspaces/scout",
  index: capacity(),
  topics: [{ path: "memory/clients.md", name: "clients.md", bytes: 40, modifiedAt: Date.now() - 60_000 }],
  logs: [],
  ...patch,
});

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();

const settle = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const page = () => $("[data-memory-page]")?.dataset.memoryPage;
const title = () => $("h3")?.textContent;
const editor = () => $<HTMLTextAreaElement>("[data-memory-editor]")!;
const click = async (element: HTMLElement | null) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
  await settle();
};
const type = async (field: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const escape = async (target: HTMLElement) => {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
};
const mount = async (next: MemoryOverview = overview()) => {
  fixture.overview = next;
  await act(async () => root.render(createElement(MemorySection, { bot, onClose })));
  await settle();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.docs = new Map([
    ["MEMORY.md", { text: "- Prefers short answers\n", hash: "main" }],
    ["memory/clients.md", { text: "Acme pays on Fridays.\n", hash: "c1" }],
    ["memory/log/2026-09-08.md", { text: "Filed the Acme invoice.\n", hash: "l1" }],
  ]);
  fixture.saves = [];
  fixture.deletes = [];
  fixture.opened = [];
  fixture.fetched = [];
  fixture.conflict = null;
  fixture.confirm.mockReset();
  fixture.confirm.mockReturnValue(true);
  vi.stubGlobal("confirm", fixture.confirm);
  onClose.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the memory page", () => {
  it("opens a note, saves an edit against the version it loaded, and goes back to the list", async () => {
    await mount();
    expect(page()).toBe("home");
    expect(title()).toBe("Memory");
    expect($("[data-memory-gauge]")).toBeNull();
    await click($('[data-memory-note="memory/clients.md"]'));
    expect(page()).toBe("note");
    expect(title()).toBe("clients");
    expect(editor().value).toBe("Acme pays on Fridays.\n");
    expect(document.activeElement).toBe($("[data-memory-back]"));
    expect($<HTMLButtonElement>("[data-memory-save]")!.disabled).toBe(true);
    await type(editor(), "Acme pays on Thursdays.\n");
    await click($("[data-memory-save]"));
    expect(fixture.saves).toEqual([{ path: "memory/clients.md", text: "Acme pays on Thursdays.\n", expectedHash: "c1" }]);
    expect($("[data-memory-save]")!.textContent).toBe("Saved");
    expect($("[data-memory-discard]")).toBeNull();
    await click($("[data-memory-back]"));
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(page()).toBe("home");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks before dropping unsaved words, and Escape steps back one level at a time", async () => {
    await mount();
    await click($('[data-memory-note="memory/clients.md"]'));
    await type(editor(), "half a thought");
    fixture.confirm.mockReturnValue(false);
    await escape(editor());
    expect(fixture.confirm).toHaveBeenCalledWith("Discard your changes to clients?");
    expect(page()).toBe("note");
    expect(editor().value).toBe("half a thought");
    fixture.confirm.mockReturnValue(true);
    await escape(editor());
    expect(page()).toBe("home");
    expect(onClose).not.toHaveBeenCalled();
    await escape($("[data-memory-back]")!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts a new note from a name, with its header filled in and the cursor ready", async () => {
    await mount();
    await click($("[data-memory-new]"));
    const name = $<HTMLInputElement>("[data-memory-new-form] input")!;
    expect(document.activeElement).toBe(name);
    await type(name, "Clients 2");
    await act(async () => $("[data-memory-new-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(fixture.fetched).toContain("memory/Clients 2.md");
    expect(title()).toBe("Clients 2");
    expect(editor().value).toBe(topicTemplate("Clients 2.md"));
    expect(document.activeElement).toBe(editor());
    expect($("[data-memory-delete]")).toBeNull();
    expect($<HTMLButtonElement>("[data-memory-save]")!.disabled).toBe(false);
    await click($("[data-memory-save]"));
    expect(fixture.saves).toEqual([{ path: "memory/Clients 2.md", text: topicTemplate("Clients 2.md"), expectedHash: "empty" }]);
    expect($("[data-memory-delete]")).not.toBeNull();
  });

  it("lets Escape close the name field without leaving the page", async () => {
    await mount();
    await click($("[data-memory-new]"));
    await escape($("[data-memory-new-form] input")!);
    expect($("[data-memory-new-form]")).toBeNull();
    expect(document.activeElement).toBe($("[data-memory-new]"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("deletes a note only after the person confirms, then lands back on the list", async () => {
    await mount();
    await click($('[data-memory-note="memory/clients.md"]'));
    fixture.confirm.mockReturnValue(false);
    await click($("[data-memory-delete]"));
    expect(fixture.confirm).toHaveBeenCalledWith("Delete clients? You can undo it under Recent changes.");
    expect(fixture.deletes).toEqual([]);
    fixture.confirm.mockReturnValue(true);
    await click($("[data-memory-delete]"));
    expect(fixture.deletes).toEqual(["memory/clients.md"]);
    expect(page()).toBe("home");
  });

  it("never offers to delete main memory", async () => {
    await mount();
    await click($('[data-memory-note="MEMORY.md"]'));
    expect(title()).toBe("Main memory");
    expect($("[data-memory-delete]")).toBeNull();
    expect($("[data-memory-gauge]")).not.toBeNull();
  });

  it("keeps the person's words when the dog changed the note meanwhile", async () => {
    fixture.conflict = "Acme pays on Mondays.\n";
    await mount();
    await click($('[data-memory-note="memory/clients.md"]'));
    await type(editor(), "mine");
    await click($("[data-memory-save]"));
    expect($("[data-memory-conflict]")!.textContent).toContain("Scout changed this note while you were editing.");
    const reload = [...$("[data-memory-conflict]")!.querySelectorAll("button")].find((button) => button.textContent === "Reload")!;
    await click(reload);
    expect(editor().value).toBe("Acme pays on Mondays.\n");
    expect($("[data-memory-draft]")!.textContent).toContain("mine");
    expect($("[data-memory-conflict]")).toBeNull();
    await type(editor(), "mine again");
    await click($("[data-memory-save]"));
    expect(fixture.saves.at(-1)).toEqual({ path: "memory/clients.md", text: "mine again", expectedHash: "theirs" });
    expect($("[data-memory-draft]")).toBeNull();
  });

  it("warns on the list only when main memory is filling up, and keeps daily logs one tap away and read-only", async () => {
    await mount(overview({
      index: capacity({ lines: 170, loadedLines: 170 }),
      logs: [{ path: "memory/log/2026-09-08.md", name: "2026-09-08.md", bytes: 24, modifiedAt: Date.now() }],
    }));
    expect($("[data-memory-gauge]")!.dataset.memoryGauge).toBe("near");
    expect($('[data-memory-level="near"]')!.textContent).toBe("Almost full");
    await click($("[data-memory-logs]"));
    expect(page()).toBe("logs");
    expect(title()).toBe("Daily logs");
    await click($('[data-memory-log="memory/log/2026-09-08.md"]'));
    expect(editor().readOnly).toBe(true);
    expect($("[data-memory-save]")).toBeNull();
    expect(document.body.textContent).toContain("Read-only. This is Scout's own record of the day.");
    await click($("[data-memory-back]"));
    expect(page()).toBe("logs");
    await click($("[data-memory-back]"));
    expect(page()).toBe("home");
  });

  it("names the Mac's file manager and opens the folder or Obsidian on request", async () => {
    await mount();
    expect($('[data-memory-open="folder"]')!.textContent).toBe("Show in Finder");
    expect($('[data-memory-open="folder"]')!.title).toBe("/Users/me/.laterdog/workspaces/scout");
    await click($('[data-memory-open="folder"]'));
    await click($('[data-memory-open="obsidian"]'));
    expect(fixture.opened).toEqual(["folder", "obsidian"]);
  });
});
