// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountDrag } from "./account-drag";

let root: Root;
let host: HTMLDivElement;
let elsewhere: HTMLInputElement;
let onMove: (ids: string[]) => void;

function List() {
  const [ids, setIds] = useState(["claude", "claude-work"]);
  const drag = useAccountDrag(ids.map((id) => ({ id, kind: "claudeAgent", movable: true })), (next) => {
    onMove(next);
    setIds(next);
  });
  return createElement("ul", null, drag.order.map((id) => createElement("li", { key: id },
    createElement("button", { type: "button", "data-id": id, onKeyDown: (event: Parameters<typeof drag.step>[0]) => drag.step(event, id, true) }, id))));
}

const handle = (id: string) => host.querySelector<HTMLButtonElement>(`[data-id="${id}"]`)!;
const order = () => [...host.querySelectorAll<HTMLButtonElement>("[data-id]")].map((element) => element.dataset.id);
const press = async (target: HTMLElement, key: string) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  elsewhere = document.createElement("input");
  document.body.append(host, elsewhere);
  root = createRoot(host);
  await act(async () => root.render(createElement(List)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("moving an account from the keyboard", () => {
  it("gives the handle its focus back when the browser drops it while the row moves", async () => {
    onMove = () => (document.activeElement as HTMLElement | null)?.blur();
    handle("claude").focus();
    await press(handle("claude"), "ArrowDown");
    expect(order()).toEqual(["claude-work", "claude"]);
    expect(document.activeElement).toBe(handle("claude"));
  });

  it("leaves focus alone when the person has already moved on to something else", async () => {
    onMove = () => elsewhere.focus();
    handle("claude").focus();
    await press(handle("claude"), "ArrowDown");
    expect(order()).toEqual(["claude-work", "claude"]);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("does nothing at the edge of the list", async () => {
    onMove = vi.fn();
    handle("claude").focus();
    await press(handle("claude"), "ArrowUp");
    expect(onMove).not.toHaveBeenCalled();
    expect(order()).toEqual(["claude", "claude-work"]);
  });
});
