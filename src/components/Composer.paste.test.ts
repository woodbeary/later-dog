// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { appendComposerDraft } from "@/lib/drafts";
import { countLines, isLongPaste, pasteAttachment, composeMessage } from "@/lib/composer-attachments";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: true } }],
      },
      dispatch: fixture.dispatch,
    }),
  };
});
const { Composer } = await import("./Composer");

let host: HTMLDivElement;
let root: Root;
let thread = 0;

const mount = async (text = "") => {
  thread += 1;
  const bot: Bot = {
    id: "paste-dog", threadId: `paste-thread-${thread}`, name: "Biscuit", title: "", description: "", color: "green",
    notifications: true, unread: false, messages: [], busy: false,
    modelSelection: { instanceId: "claude", model: "claude-fake" },
  };
  if (text) appendComposerDraft(`bot:${bot.id}:${bot.threadId}`, text);
  await act(async () => root.render(createElement(Composer, { bot })));
  return host.querySelector("textarea")!;
};

const paste = async (field: HTMLTextAreaElement, text: string) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items: [], files: [], getData: () => text } });
  await act(async () => { field.dispatchEvent(event); });
  return event;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/files?")) return Response.json({ path: "/fixture/pasted.txt", name: new URL(String(input), "http://fixture").searchParams.get("name"), bytes: (init?.body as Blob | undefined)?.size ?? 0 });
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

describe("pasted text attachments", () => {
  it("leaves short clipboard text to the normal paste action", async () => {
    const field = await mount("Keep this");
    expect((await paste(field, "a".repeat(899))).defaultPrevented).toBe(false);
    expect(host.querySelector('[aria-label="Remove pasted text"]')).toBeNull();
  });

  it("keeps a long paste out of the message box and sends every character", async () => {
    const field = await mount("Please read this");
    const text = "café 🐕\n".repeat(160);
    expect((await paste(field, text)).defaultPrevented).toBe(true);
    expect(field.value).toBe("Please read this");
    expect(host.querySelector('[aria-label="Remove pasted text"]')).not.toBeNull();
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const sent = fixture.dispatch.mock.calls.map(([action]) => action).find(action => action.type === "send");
    expect(sent.text).toBe('Please read this\n\n<attached-file path="/fixture/pasted.txt" name="Pasted text.txt" />');
    const upload = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/api/files?"))!;
    expect(await (upload[1]!.body as File).text()).toBe(text);
    expect(field.value).toBe("");
    expect(host.querySelector('[aria-label="Remove pasted text"]')).toBeNull();
  });

  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("recognizes twelve clipboard lines separated by %j", async (separator) => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join(separator);
    const field = await mount("Keep this");
    expect((await paste(field, text)).defaultPrevented).toBe(true);
    expect(field.value).toBe("Keep this");
    expect(host.querySelector('[aria-label="Remove pasted text"]')).not.toBeNull();
    expect(countLines(text)).toBe(12);
    expect(pasteAttachment(text).text).toBe(text);
  });

  it("replaces the selected draft words without dropping the rest of the draft", async () => {
    const field = await mount("before selected after");
    field.setSelectionRange(7, 15);
    await paste(field, "x".repeat(900));
    expect(field.value).toBe("before  after");
    expect(host.querySelectorAll('[aria-label="Remove pasted text"]')).toHaveLength(1);
  });

  it("lets the person edit a paste in the box with the existing draft kept", async () => {
    const field = await mount("Please read this");
    const text = "x".repeat(900);
    await paste(field, text);
    await act(async () => { (host.querySelector('[aria-label="Edit text in chat box"]') as HTMLButtonElement).click(); });
    expect(field.value).toBe(`Please read this\n\n${text}`);
    expect(host.querySelector('[aria-label="Remove pasted text"]')).toBeNull();
  });

  it("removes a paste while keeping the person's draft", async () => {
    const field = await mount("Keep this");
    await paste(field, "x".repeat(900));
    await act(async () => { (host.querySelector('[aria-label="Remove pasted text"]') as HTMLButtonElement).click(); });
    expect(field.value).toBe("Keep this");
    expect(host.querySelector('[aria-label="Remove pasted text"]')).toBeNull();
  });

  it("keeps Send disabled during upload and does not bring back a removed paste", async () => {
    let finish!: (response: Response) => void;
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes("/api/files?")
      ? new Promise<Response>(resolve => { finish = resolve; })
      : fallback(input, init));
    const field = await mount("Keep this");
    await paste(field, "x".repeat(900));
    expect((host.querySelector("[data-composer-send]") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (host.querySelector('[aria-label="Remove pasted text"]') as HTMLButtonElement).click(); });
    await act(async () => { finish(Response.json({ path: "/fixture/pasted.txt", name: "Pasted text.txt", bytes: 900 })); });
    expect(field.value).toBe("Keep this");
    expect(host.querySelector('[aria-label="Remove pasted text"]')).toBeNull();
    expect((host.querySelector("[data-composer-send]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("gives each paste its own file name", async () => {
    const field = await mount();
    await paste(field, "x".repeat(900));
    await paste(field, "y".repeat(900));
    const names = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/api/files?"))
      .map(([url]) => new URL(String(url), "http://fixture").searchParams.get("name"));
    expect(names).toEqual(["Pasted text.txt", "Pasted text 2.txt"]);
  });

  it("keeps the shared character and line boundaries exact", () => {
    expect(isLongPaste("x".repeat(899))).toBe(false);
    expect(isLongPaste("x".repeat(900))).toBe(true);
    expect(isLongPaste(Array(11).fill("x").join("\n"))).toBe(false);
    expect(isLongPaste(Array(12).fill("x").join("\n"))).toBe(true);
    expect(isLongPaste("🐕".repeat(449) + "a")).toBe(false);
    expect(isLongPaste("🐕".repeat(450))).toBe(true);
    expect(countLines("")).toBe(1);
    const text = "a\r\nb\rc\nd\u2028e\u2029f";
    const attachment = pasteAttachment(text);
    expect(attachment.lines).toBe(6);
    expect(composeMessage("", [attachment])).toBe(`<pasted-text index="1">\n${text}\n</pasted-text>`);
  });
});
