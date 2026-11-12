// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkStatusLine } from "./WorkStatusLine";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const draw = (bot: Parameters<typeof WorkStatusLine>[0]["bot"]) => act(() => root.render(createElement(WorkStatusLine, { bot })));

it("says what the chat is waiting for in the header", () => {
  draw({ busy: false, work: { kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }] } });
  expect(host.querySelector("[role=status]")?.textContent).toBe("Waiting on Scout");
  draw({ busy: true, work: { kind: "retrying", attempt: 2 } });
  expect(host.querySelector("[data-work-state=retrying]")?.textContent).toBe("Reconnecting to the engine, try 2");
});

it("shows nothing for plain running or idle work", () => {
  draw({ busy: true, work: { kind: "running" } });
  expect(host.textContent).toBe("");
  draw({ busy: false, work: { kind: "idle" } });
  expect(host.textContent).toBe("");
});

it("falls back to the teammate wait line from a home that sends no work state", () => {
  draw({ busy: false, waitingForTeammates: true, waitingOn: [{ botId: "scout", name: "Scout" }] });
  expect(host.textContent).toBe("Waiting on Scout");
});
