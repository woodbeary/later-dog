// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  capabilities: { queueing: true, steerImages: true } as Record<string, boolean>,
  queued: [] as Array<{ queueId: string; text: string }>,
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "codex", driverKind: "codex", displayName: "Codex", capabilities: fixture.capabilities }],
        pendingQueued: { "thread-1": fixture.queued },
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { setLocale } = await import("@/lib/i18n");

const coordinator: Bot = {
  id: "coordinator", threadId: "thread-1", name: "coordinator", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy: true,
  modelSelection: { instanceId: "codex", model: "gpt" },
};
const picture = `<attached-image path="/tmp/123e4567-e89b-42d3-a456-426614174000.png" name="shot.png" />`;

let host: HTMLDivElement;
let root: Root;

const mount = async () => {
  await act(async () => root.render(createElement(Composer, { bot: coordinator })));
};
const steerButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send now");
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action.type);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.capabilities = { queueing: true, steerImages: true };
  fixture.queued = [{ queueId: "q1", text: "hello" }];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the Steer button on a queued message", () => {
  it.each([
    ["an engine that steers live", { queueing: true, steerImages: true }, "hello"],
    ["a picture the engine cannot steer live", { queueing: true, steerImages: false }, `look\n\n${picture}`],
    ["an engine that only queues", { queueing: false }, "hello"],
  ])("asks the server to steer for %s, never a bare Stop", async (_, capabilities, text) => {
    fixture.capabilities = capabilities;
    fixture.queued = [{ queueId: "q1", text }];
    await mount();
    expect(steerButton()).toBeDefined();
    await act(async () => steerButton()!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "steerQueued", botId: "coordinator", threadId: "thread-1", queueId: "q1",
      onError: expect.any(Function), onSettled: expect.any(Function),
    }));
    expect(actions()).not.toContain("interrupt");
  });

  it("sends the queued picture on the second Enter even when the engine cannot steer pictures live", async () => {
    fixture.capabilities = { queueing: true, steerImages: false };
    fixture.queued = [];
    await mount();
    fixture.queued = [{ queueId: "q1", text: picture }];
    await mount();
    const textarea = host.querySelector("textarea")!;
    expect(textarea.placeholder).toContain("Press Enter again");
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "steerQueued", queueId: "q1" }));
    expect(actions()).not.toContain("send");
  });
});
