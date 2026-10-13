// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  upload: vi.fn(),
  flushBotPatches: vi.fn(async () => null),
  config: null as null | { imageGen?: { configured: boolean } },
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch, flushBotPatches: fixture.flushBotPatches }),
}));
vi.mock("@/lib/composer-attachments", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/composer-attachments")>(),
  imageAttachmentFromFile: fixture.upload,
}));
vi.mock("../Avatar", async (importOriginal) => ({
  ...await importOriginal<typeof import("../Avatar")>(),
  BotAvatar: () => createElement("span", { "data-bot-avatar": "" }),
}));

const { ProfileAvatar } = await import("./ProfileAvatar");

let root: Root;
let host: HTMLDivElement;
const onPatch = vi.fn();
const FRESH = { avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 };

const scout = (patch: Partial<Bot> = {}) => ({ id: "scout", name: "Scout", color: "green", ...patch }) as unknown as Bot;
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const show = (bot: Bot) => act(async () => root.render(createElement(ProfileAvatar, { bot, state: "idle", onPatch })));
const trigger = () => host.querySelector<HTMLButtonElement>("[data-avatar-edit]")!;
const menu = () => host.querySelector<HTMLElement>("[data-avatar-menu]");
const option = (id: string) => host.querySelector<HTMLButtonElement>(`[data-avatar-option="${id}"]`)!;
const press = (element: HTMLElement) => act(async () => element.click());
const key = (element: Element, name: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});
const pickFile = async (file: File) => {
  const input = host.querySelector<HTMLInputElement>("[data-avatar-file]")!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
};
const picture = () => new File([new Uint8Array([1, 2, 3])], "kite.png", { type: "image/png" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset();
  fixture.upload.mockReset();
  fixture.flushBotPatches.mockClear();
  fixture.config = null;
  onPatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the dog's picture", () => {
  it("opens Dog, Generate and Upload from the picture, moves with the arrows and closes with Escape", async () => {
    await show(scout());
    expect(trigger().getAttribute("aria-label")).toBe("Change Scout's picture");
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();

    await press(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')];
    expect(items.map((item) => item.dataset.avatarOption)).toEqual(["dog", "generate", "upload"]);
    expect(option("dog").getAttribute("role")).toBe("menuitemradio");
    expect(option("dog").getAttribute("aria-checked")).toBe("true");
    expect(option("generate").disabled).toBe(false);
    expect(option("generate").textContent).toContain("Picture generation isn't set up here");
    expect(document.activeElement).toBe(option("dog"));

    await key(option("dog"), "ArrowDown");
    expect(document.activeElement).toBe(option("generate"));
    await key(option("generate"), "ArrowDown");
    expect(document.activeElement).toBe(option("upload"));
    await key(option("upload"), "ArrowDown");
    expect(document.activeElement).toBe(option("dog"));

    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    await key(option("dog"), "Escape");
    window.removeEventListener("keydown", outside);
    expect(menu()).toBeNull();
    expect(outside).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when you press anywhere else", async () => {
    await show(scout());
    await press(trigger());
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();
  });

  it("puts the dog back in place of a picture, and leaves a dog alone", async () => {
    await show(scout({ avatarUrl: "/api/attachments/abc-123.png", avatarCrop: "rounded" }));
    await press(trigger());
    expect(option("dog").getAttribute("aria-checked")).toBe("false");
    await press(option("dog"));
    expect(onPatch).toHaveBeenLastCalledWith({ avatarUrl: null, avatarCrop: "mascot", ...FRESH });
    expect(menu()).toBeNull();

    onPatch.mockReset();
    await show(scout());
    await press(trigger());
    await press(option("dog"));
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("uploads a picture as a fresh, centred circle, keeping a shape that was already chosen", async () => {
    fixture.upload.mockResolvedValue({ path: "/tmp/attachments/abc-123.png" });
    await show(scout());
    await press(trigger());
    await press(option("upload"));
    expect(menu()).toBeNull();
    await pickFile(picture());
    expect(onPatch).toHaveBeenLastCalledWith({ avatarUrl: "/api/attachments/abc-123.png", avatarCrop: "circle", ...FRESH });

    await show(scout({ avatarUrl: "/api/attachments/old.png", avatarCrop: "square" }));
    await pickFile(picture());
    expect(onPatch).toHaveBeenLastCalledWith({ avatarUrl: "/api/attachments/abc-123.png", avatarCrop: "square", ...FRESH });
  });

  it("says which pictures work when the file isn't one", async () => {
    fixture.upload.mockResolvedValue(null);
    await show(scout());
    await pickFile(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Choose a PNG, JPEG, GIF, or WebP picture.");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("generates a picture from a few words once picture generation is set up", async () => {
    fixture.config = { imageGen: { configured: true } };
    let answer!: (value: unknown) => void;
    fixture.api.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await show(scout());
    await press(trigger());
    expect(option("generate").disabled).toBe(false);
    await press(option("generate"));

    const describe = host.querySelector<HTMLInputElement>('[aria-label="Describe the picture (optional)"]')!;
    expect(document.activeElement).toBe(describe);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(describe, "a red kite");
      describe.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-avatar-generate] button")!.click());
    await settle();

    expect(fixture.flushBotPatches).toHaveBeenCalledWith("scout");
    const [path, init] = fixture.api.mock.calls[0]!;
    expect(path).toBe("/api/bots/scout/avatar/generate");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ prompt: "a red kite" }), timeoutMs: 150_000 });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Generating…");
    expect(menu()).toBeNull();

    await act(async () => answer({ avatarUrl: "/api/attachments/kite.png", bot: { avatarCrop: "circle" } }));
    await settle();
    expect(onPatch).toHaveBeenLastCalledWith({ avatarUrl: "/api/attachments/kite.png", avatarCrop: "circle", ...FRESH });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("shows why a picture couldn't be generated", async () => {
    fixture.config = { imageGen: { configured: true } };
    fixture.api.mockRejectedValue(new Error("The picture service is busy"));
    await show(scout());
    await press(trigger());
    await press(option("generate"));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-avatar-generate] button")!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("The picture service is busy");
    expect(onPatch).not.toHaveBeenCalled();
  });
  it("opens secure key setup from Generate when images are not configured", async () => {
    await show(scout());
    await press(trigger());
    await press(option("generate"));
    expect(host.querySelector("[data-image-generation-setup]")).not.toBeNull();
    expect(host.querySelector('input[type="password"]')?.getAttribute("aria-label")).toBe("OpenAI image API key");
    expect(host.querySelector("[data-avatar-generate]")?.textContent).toContain("Your chat subscription does not include image API access");
    expect(fixture.api).not.toHaveBeenCalled();
  });

});
