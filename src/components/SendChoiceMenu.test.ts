// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SendDelivery } from "../../shared/send-delivery";
import { SendChoiceMenu } from "./SendChoiceMenu";

let host: HTMLDivElement;
let root: Root;
const onChoose = vi.fn<(delivery: SendDelivery) => void>();

const mount = (props: { canSteer: boolean; disabled?: boolean }) =>
  act(async () => root.render(createElement(SendChoiceMenu, { name: "Biscuit", onChoose, ...props })));
const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>("[role=menu]:not([aria-hidden]) [role=menuitem]")];
const deliveries = () => items().map((item) => item.dataset.delivery);
const onEnter = () => items().filter((item) => item.getAttribute("aria-keyshortcuts") === "Enter").map((item) => item.dataset.delivery);
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.delivery;
const open = () => act(async () => trigger().click());
const press = (key: string) =>
  act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  onChoose.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("sending while a dog works", () => {
  it("offers Steer now, Queue and Stop and send, with what Enter does marked and focused", async () => {
    await mount({ canSteer: true });
    expect(trigger().getAttribute("aria-label")).toBe("More ways to send");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(items()).toEqual([]);

    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("[role=menu]")?.getAttribute("aria-label")).toBe("Send while Biscuit works");
    expect(deliveries()).toEqual(["steer", "queue", "stop"]);
    expect(host.textContent).toContain("Steer now");
    expect(host.textContent).toContain("Biscuit reads it while it keeps working");
    expect(host.textContent).toContain("Sends when Biscuit finishes");
    expect(host.textContent).toContain("Stops Biscuit and sends this now");
    expect(onEnter()).toEqual(["steer"]);
    expect(focused()).toBe("steer");
  });

  it("leaves Steer out where the engine can only queue, and marks Queue as Enter's choice", async () => {
    await mount({ canSteer: false });
    await open();
    expect(deliveries()).toEqual(["queue", "stop"]);
    expect(onEnter()).toEqual(["queue"]);
    expect(focused()).toBe("queue");
  });

  it("hands back the choice and closes", async () => {
    await mount({ canSteer: true });
    await open();
    await act(async () => items().find((item) => item.dataset.delivery === "stop")!.click());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("stop");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("moves with the arrow keys, and Escape closes it back onto its button", async () => {
    await mount({ canSteer: true });
    await open();
    await press("ArrowDown");
    expect(focused()).toBe("queue");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(focused()).toBe("steer");
    await press("ArrowUp");
    expect(focused()).toBe("stop");
    await press("Escape");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("closes on a press outside or a Tab away, without choosing", async () => {
    await mount({ canSteer: false });
    await open();
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await open();
    await press("Tab");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("stays shut while an attachment is still uploading", async () => {
    await mount({ canSteer: true });
    await open();
    await mount({ canSteer: true, disabled: true });
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
