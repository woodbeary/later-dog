// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Action, AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { citationAttachment, serializeCitation } = await import("@/lib/citations");

const cloudPicture = "/data/.laterdog/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png";
const macPicture = "/Users/jacob/.laterdog/attachments/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg";
const screenshot = "Screenshot 2026-10-15 at 1.53.02 PM.png";
const cloudTag = `<attached-image path="${cloudPicture}" name="${screenshot}" />`;
const macTag = `<attached-image path="${macPicture}" name="mac.jpg" />`;
const citation = citationAttachment(
  { ownerType: "bot", ownerId: "pepper", threadId: "pepper-thread", messageId: "m2" },
  { text: "Nice colours.", start: 0, end: 13, prefix: "", suffix: "" },
);

const message = (id: string, parentId: string | undefined, fields: Partial<Message>): Message =>
  ({ id, parentId, role: "user", kind: "text", at: new Date(2026, 9, 15, 13, Number(id.slice(1))).getTime(), ...fields });

const conversation: Message[] = [
  message("m1", undefined, { text: `look at this\n\n${cloudTag}` }),
  message("m2", "m1", { role: "bot", text: "Nice colours." }),
  message("m3", "m2", { text: `${cloudTag}\n\n${macTag}` }),
  message("m4", "m3", { role: "bot", text: "Two more." }),
  message("m5", "m4", { text: `about that\n\n${serializeCitation(citation)}` }),
  message("m6", "m5", { role: "bot", text: "Yes." }),
];

const pepper = (messages: Message[]): Bot => ({
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
});

let host: HTMLDivElement;
let root: Root;
let dispatch: Mock<(action: Action) => void>;

const mount = async (messages: Message[]) => {
  const bot = pepper(messages);
  const state: AppState = {
    ...initialState,
    connected: true,
    selectedId: "pepper",
    bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, capabilities: { images: true } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
};
const row = (id: string) => host.querySelector<HTMLElement>(`[data-mid='${id}']`)!;
const pencil = (id: string) => row(id).querySelector<HTMLButtonElement>('button[aria-label="Edit message"]');
const editor = (id: string) => row(id).querySelector<HTMLTextAreaElement>("textarea");
const sendButton = (id: string) => [...row(id).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send")!;
const keptPictures = (id: string) => [...row(id).querySelectorAll<HTMLImageElement>("[data-sent-attachments] img")];
const type = async (textarea: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const edits = () => dispatch.mock.calls.flatMap(([action]) => action.type === "editMessage" ? [action] : []);
const tagCount = (text: string) => text.match(/<attached-image/g)?.length ?? 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  dispatch = vi.fn<(action: Action) => void>();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("editing a sent message with pictures", () => {
  it("edits the words while the picture stays, and sends the picture once", async () => {
    await mount(conversation);
    expect(pencil("m1")).not.toBeNull();
    await act(async () => pencil("m1")!.click());
    expect(editor("m1")!.value).toBe("look at this");
    expect(keptPictures("m1").map((image) => image.getAttribute("src"))).toEqual(["/api/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png"]);

    await type(editor("m1")!, "look at this one instead");
    await act(async () => sendButton("m1").click());
    expect(edits()).toEqual([expect.objectContaining({
      botId: "pepper",
      messageId: "m1",
      text: `look at this one instead\n\n${cloudTag}`,
    })]);
    expect(tagCount(edits()[0].text)).toBe(1);
  });

  it("keeps Mac and Cloud pictures sent without words", async () => {
    await mount(conversation);
    await act(async () => pencil("m3")!.click());
    expect(editor("m3")!.value).toBe("");
    expect(keptPictures("m3")).toHaveLength(2);
    expect(sendButton("m3").disabled).toBe(false);

    await act(async () => sendButton("m3").click());
    expect(edits()[0].text).toBe(`${cloudTag}\n\n${macTag}`);
  });

  it("still leaves messages that quote another message uneditable", async () => {
    await mount(conversation);
    expect(pencil("m5")).toBeNull();
  });

  it("opens the last message with a picture for editing from the arrow key", async () => {
    await mount(conversation.slice(0, 2));
    const composer = host.querySelector<HTMLTextAreaElement>("[data-tour=composer] textarea") ?? [...host.querySelectorAll("textarea")].at(-1)!;
    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(editor("m1")?.value).toBe("look at this");
    expect(keptPictures("m1")).toHaveLength(1);
  });
});
