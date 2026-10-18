import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const dispatch = vi.fn();
vi.mock("react-dom", async (importOriginal) => ({ ...await importOriginal<object>(), createPortal: (node: ReactNode) => node }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [main, other, hidden] }, dispatch }) };
});

const dog = (patch: Partial<Bot>): Bot => ({
  id: "dog", threadId: "thread", name: "Dog", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "test", model: "test" }, ...patch,
});
const main = dog({ id: "main", threadId: "t-main", name: "Biscuit", chiefOfStaff: true });
const other = dog({ id: "other", threadId: "t-other", name: "Pepper" });
const hidden = dog({ id: "hidden", threadId: "t-hidden", name: "Willow", hidden: true });

vi.stubGlobal("document", { body: {} });
vi.stubGlobal("window", { innerWidth: 1_000, innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() });
const { BotContextMenu } = await import("./Sidebar");
const { mainDogChoices } = await import("./MainDogPicker");

const menuFor = (botId: string) => renderToStaticMarkup(createElement(BotContextMenu, {
  menu: { botId, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onReplaceMainDog: vi.fn(), onMoveToSection: vi.fn(),
}));

describe("the main dog", () => {
  it("offers Replace with different dog instead of Delete, and can still be hidden", () => {
    const markup = menuFor("main");
    expect(markup).toContain("Replace with different dog…");
    expect(markup).not.toContain(">Delete</button>");
    expect(markup).toContain(">Archive</button>");
    expect(markup).not.toMatch(/Chief of Staff/);
  });

  it("leaves Delete on every other dog and offers no Chief of Staff choice", () => {
    const markup = menuFor("other");
    expect(markup).toContain(">Delete</button>");
    expect(markup).not.toContain("Replace with different dog");
    expect(markup).not.toMatch(/Chief of Staff/);
  });

  it("lists every other visible dog in the picker and narrows by name", () => {
    expect(mainDogChoices([main, other, hidden], "main", "").map((bot) => bot.id)).toEqual(["other"]);
    expect(mainDogChoices([main, other, hidden], "main", "pep").map((bot) => bot.id)).toEqual(["other"]);
    expect(mainDogChoices([main, other, hidden], "main", "zz")).toEqual([]);
  });
});
