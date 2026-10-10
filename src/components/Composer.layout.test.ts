// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

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

let host: HTMLDivElement;
let root: Root;
let thread = 0;

const settle = () => act(async () => {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
});

const biscuit = (): Bot => {
  thread += 1;
  return {
    id: "biscuit", threadId: `thread-${thread}`, name: "Biscuit", title: "", description: "", color: "green",
    notifications: true, unread: false, messages: [], busy: false,
    modelSelection: { instanceId: "claude", model: "claude-fake" },
  };
};

const mount = async (props: { bot?: Bot; replyTo?: Message } = {}) => {
  const bot = props.bot ?? biscuit();
  await act(async () => root.render(createElement(Composer, { bot, replyTo: props.replyTo, onClearReply: () => {} })));
  return bot;
};

const box = () => host.querySelector<HTMLElement>("[data-tour='composer']")!;
const row = () => box().querySelector<HTMLElement>("[data-composer-row]")!;
const editor = () => host.querySelector("textarea")!.closest<HTMLElement>(".mention-editor")!;
const expanded = () => box().hasAttribute("data-expanded");
const before = (first: Node, second: Node) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

const type = async (value: string) => {
  const textarea = host.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const pick = async (count: number) => {
  const files = Array.from({ length: count }, (_, index) => new File([new Uint8Array([137, 80, 78, 71])], `photo-${index + 1}.png`, { type: "image/png" }));
  const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let uploads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/attachments?")) {
      uploads += 1;
      return Response.json({ path: `/tmp/attachments/${uploads.toString(16).padStart(32, "0")}.png`, mime: "image/png", bytes: 4 });
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

describe("the message box", () => {
  it("is one line when empty: attach on the left, the words, then permissions and send on the right", async () => {
    await mount();
    expect(expanded()).toBe(false);
    expect(box().className).toContain("rounded-3xl");
    expect(row().classList.contains("flex-wrap")).toBe(false);
    expect(editor().classList.contains("basis-full")).toBe(false);

    const tools = row().querySelector("[data-composer-tools]")!;
    const actions = row().querySelector("[data-composer-actions]")!;
    expect(tools.querySelector("button[aria-label='Attach a file']")).not.toBeNull();
    expect(before(tools, editor())).toBe(true);
    expect(before(editor(), actions)).toBe(true);
    expect(actions.querySelector("button[aria-label$=' for Claude']")).not.toBeNull();
    expect(tools.querySelector("button[aria-label$=' for Claude']")).toBeNull();
  });

  it("gives a second line of words the whole width, with the buttons underneath", async () => {
    await mount();
    await type("first line\nsecond line");
    expect(expanded()).toBe(true);
    expect(box().className).toContain("rounded-[20px]");
    expect(row().classList.contains("flex-wrap")).toBe(true);
    expect(editor().classList.contains("order-first")).toBe(true);
    expect(editor().classList.contains("basis-full")).toBe(true);
  });

  it("stays big while there are words, and goes back to one line once they are gone", async () => {
    await mount();
    await type("first line\nsecond line");
    await type("first line");
    expect(expanded()).toBe(true);
    await type("");
    expect(expanded()).toBe(false);
  });

  it("keeps pictures inside the box, above the words", async () => {
    await mount();
    await pick(2);
    const previews = box().querySelectorAll("button[aria-label^='Preview ']");
    expect(previews).toHaveLength(2);
    expect(expanded()).toBe(true);
    const tray = box().querySelector("[data-composer-attachments]")!;
    expect(before(tray, row())).toBe(true);
    for (const preview of previews) expect(tray.contains(preview)).toBe(true);
  });

  it("keeps the picture limit note inside the box too", async () => {
    await mount();
    await pick(5);
    const note = host.querySelector("[role=status]")!;
    expect(note.textContent).toContain("A message can have up to 4 pictures.");
    expect(box().contains(note)).toBe(true);
  });

  it("goes back to one line when the last picture is removed", async () => {
    await mount();
    await pick(1);
    expect(expanded()).toBe(true);
    await act(async () => box().querySelector<HTMLButtonElement>("button[aria-label='Remove file']")!.click());
    expect(box().querySelector("button[aria-label^='Preview ']")).toBeNull();
    expect(expanded()).toBe(false);
  });

  it("shows the message being answered inside the box", async () => {
    const replyTo: Message = { id: "m1", role: "bot", kind: "text", text: "Want me to run the tests?", at: 0 };
    await mount({ replyTo });
    expect(expanded()).toBe(true);
    const cancel = box().querySelector("button[aria-label='Cancel reply']")!;
    expect(cancel).not.toBeNull();
    expect(before(cancel, row())).toBe(true);
    expect(box().textContent).toContain("Want me to run the tests?");
  });
});
