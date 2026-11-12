// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState } from "@/state/store";
import { TurnReceiptLine } from "./TurnReceiptLine";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const draw = (receipt: Parameters<typeof TurnReceiptLine>[0]["receipt"]) => act(async () => root.render(createElement(BotEditorStore, {
  value: { state: initialState, dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) },
  children: createElement(TurnReceiptLine, { receipt }),
})));

it("shows what ran a finished turn", async () => {
  await draw({ account: "Work account", instanceId: "work", model: "large", effort: "low" });
  expect(host.querySelector("[data-turn-receipt]")?.textContent).toBe("Ran on Work account · large · Low");
});

it("shows nothing for a legacy message with no receipt", async () => {
  await draw(undefined);
  expect(host.innerHTML).toBe("");
});
