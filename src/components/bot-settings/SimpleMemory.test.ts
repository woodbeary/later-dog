// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { SimpleMemory, rememberedItems, withoutLine } from "./SimpleMemory";

const fixture = vi.hoisted(() => ({
  text: "",
  saves: [] as Array<{ path: string; text: string; expectedHash: string | undefined }>,
}));

vi.mock("@/lib/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory")>();
  const overview = () => ({
    botId: "scout",
    workspacePath: "/w",
    index: { lines: 1, bytes: 10, maxLines: 200, maxBytes: 24_000, loadedLines: 1, loadedBytes: 10, truncated: false, hash: "main" },
    topics: [],
    logs: [],
  });
  return {
    ...actual,
    fetchMemoryOverview: vi.fn(async () => overview()),
    fetchMemoryDoc: vi.fn(async (_botId: string, path: string) => ({ path, text: fixture.text, hash: "main", exists: true })),
    fetchMemoryJournal: vi.fn(async () => []),
    fetchUpkeepStatus: vi.fn(async () => ({ enabled: true, modelSteps: true })),
    saveMemoryDoc: vi.fn(async (_botId: string, path: string, text: string, expectedHash: string | undefined) => {
      fixture.saves.push({ path, text, expectedHash });
      fixture.text = text;
      return { ok: true, doc: { path, text, hash: "next", exists: true }, overview: overview() };
    }),
  };
});
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "darwin" } } }),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: {}, dispatch: vi.fn() }),
}));

const FILE = `# Memory

Durable notes this bot keeps between tasks. The first 200 lines
load at the start of every session.

## Sam
- Prefers **short** answers
- Works on [later.dog](https://later.dog) at night
* Uses \`pnpm\`, never npm
- [x] Ships on Fridays
`;

describe("memory as a person reads it", () => {
  it("lists only the remembered lines, as plain sentences", () => {
    expect(rememberedItems(FILE).map((item) => item.words)).toEqual([
      "Prefers short answers",
      "Works on later.dog at night",
      "Uses pnpm, never npm",
      "Ships on Fridays",
    ]);
  });

  it("forgets one line and keeps the rest of the file as it was", () => {
    const [, second] = rememberedItems(FILE);
    const after = withoutLine(FILE, second!.line);
    expect(after).not.toContain("later.dog");
    expect(after).toContain("# Memory");
    expect(after).toContain("- Prefers **short** answers");
    expect(rememberedItems(after)).toHaveLength(3);
  });

  it("leaves the file alone when the line is already gone", () => {
    expect(withoutLine(FILE, "- not there")).toBe(FILE);
  });
});

describe("the memory card", () => {
  let root: Root;
  let host: HTMLDivElement;
  const onPage = vi.fn();
  const onToggle = vi.fn();
  const scout = (patch: Partial<Bot> = {}) => ({ id: "scout", name: "Scout", memoryEnabled: true, busy: false, ...patch }) as unknown as Bot;
  const settle = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
  const show = async (bot: Bot, page = false) => {
    await act(async () => root.render(createElement(SimpleMemory, { bot, active: true, page, onPage, onToggle })));
    await settle();
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fixture.text = FILE;
    fixture.saves = [];
    onPage.mockReset();
    onToggle.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("lists what the dog remembers and ends in a row that clearly leads somewhere", async () => {
    await show(scout());
    expect([...document.body.querySelectorAll("[data-remembered]")].map((row) => row.textContent)).toEqual([
      "Prefers short answers",
      "Works on later.dog at night",
      "Uses pnpm, never npm",
      "Ships on Fridays",
    ]);
    const manage = $("[data-memory-files]")!;
    expect(manage.textContent).toBe("Manage memory");
    expect(manage.querySelectorAll("svg")).toHaveLength(2);
    await act(async () => manage.click());
    expect(onPage).toHaveBeenCalledWith(true);
  });

  it("forgets one thing in a click, against the version it showed", async () => {
    await show(scout());
    await act(async () => $<HTMLButtonElement>('[aria-label="Forget “Works on later.dog at night”"]')!.click());
    await settle();
    expect(fixture.saves).toEqual([{ path: "MEMORY.md", text: withoutLine(FILE, "- Works on [later.dog](https://later.dog) at night"), expectedHash: "main" }]);
    expect(document.body.querySelectorAll("[data-remembered]")).toHaveLength(3);
  });

  it("cannot be switched while the dog is working, and says why", async () => {
    await show(scout({ busy: true }));
    const toggle = $<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.parentElement!.title).toBe("Stop Scout's turn to change this.");
  });

  it("says in one line what off means", async () => {
    await show(scout({ memoryEnabled: false }));
    expect($("[data-memory-off]")!.textContent).toBe("Off. Saved notes stay, but Scout won't read or add to them.");
    expect($("[data-remembered]")).toBeNull();
    await act(async () => $<HTMLButtonElement>('[role="switch"]')!.click());
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("swaps to the memory page, and Back returns focus to Manage memory", async () => {
    await show(scout(), true);
    expect($("[data-simple-memory]")).toBeNull();
    expect($("[data-memory-page]")!.dataset.memoryPage).toBe("home");
    await act(async () => $("[data-memory-back]")!.click());
    expect(onPage).toHaveBeenCalledWith(false);
    await show(scout(), false);
    expect($("[data-memory-page]")!.closest("[hidden]")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-memory-files]"));
  });
});
