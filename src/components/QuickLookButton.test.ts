// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./AttachmentPreview", () => ({ requestMessageFile: fixture.request }));

const { QuickLookButton } = await import("./QuickLookButton");

let root: Root;
let host: HTMLDivElement;
const message = { threadId: "t1", messageId: "m1" };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.request.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (window as { laterdog?: unknown }).laterdog;
});

const render = (name: string) => act(() => root.render(createElement(QuickLookButton, { path: `/work/${name}`, name, message })));
const button = () => host.querySelector<HTMLButtonElement>("[data-quick-look]");
const settle = () => act(async () => { for (let round = 0; round < 6; round += 1) await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); });

describe("previewing a document from the chat", () => {
  it("hands the file's bytes to the Mac's viewer", async () => {
    const previewFile = vi.fn(async () => true);
    (window as { laterdog?: unknown }).laterdog = { previewFile };
    fixture.request.mockResolvedValue(new Response(new Uint8Array([80, 75, 3, 4])));
    render("plan.xlsx");
    expect(button()?.getAttribute("data-quick-look")).toBe("native");
    expect(button()?.getAttribute("aria-label")).toBe("Preview plan.xlsx");
    act(() => button()!.click());
    await settle();
    expect(fixture.request).toHaveBeenCalledWith("/work/plan.xlsx", message, expect.any(AbortSignal));
    expect(previewFile).toHaveBeenCalledWith("plan.xlsx", new Uint8Array([80, 75, 3, 4]));
    expect(button()?.getAttribute("aria-label")).toBe("Preview plan.xlsx");
  });

  it("says so, and offers to try again, when the file can't be fetched", async () => {
    (window as { laterdog?: unknown }).laterdog = { previewFile: vi.fn(async () => true) };
    fixture.request.mockRejectedValue(new Error("gone"));
    render("deck.key");
    act(() => button()!.click());
    await settle();
    expect(button()?.getAttribute("aria-label")).toBe("Couldn't preview deck.key. Try again, or save it to open it.");
  });

  it("opens a PDF in the browser's own viewer on the web", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.stubGlobal("open", vi.fn(() => tab));
    fixture.request.mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70])));
    render("paper.pdf");
    expect(button()?.getAttribute("data-quick-look")).toBe("browser");
    act(() => button()!.click());
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    await settle();
    expect(tab.location.href).toMatch(/^blob:/);
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("offers nothing for files no viewer here can show", () => {
    render("photo.png");
    expect(button()).toBeNull();
    render("deck.pptx");
    expect(button()).toBeNull();
    (window as { laterdog?: unknown }).laterdog = {};
    render("paper.pdf");
    expect(button()).toBeNull();
  });
});
