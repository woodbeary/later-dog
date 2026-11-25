import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { TurnSlot } from "./TurnSlot";

vi.mock("@/lib/native-runs-state", () => ({ useNativeRuns: () => [] }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

let browser: Window;
let host: HTMLDivElement;
let root: Root;

const dog: Bot = {
  id: "scout",
  threadId: "thread",
  name: "Scout",
  title: "",
  description: "",
  color: "yellow",
  notifications: true,
  unread: false,
  busy: true,
  activity: "waiting-on-you",
  messages: [],
  modelSelection: { instanceId: "fixture", model: "fixture" },
};

beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("navigator", browser.navigator);
  vi.stubGlobal("HTMLElement", browser.HTMLElement);
  vi.stubGlobal("MutationObserver", browser.MutationObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  browser.happyDOM.abort();
  vi.unstubAllGlobals();
});

describe("a turn slot's request link", () => {
  it.each(["data-question-card", "data-approval-card", "data-takeover-card", "data-secure-form"])(
    "focuses its own pane's %s instead of another visible pane",
    (attribute) => {
      const card = (id: string) =>
        createElement("section", { [attribute]: "open" }, createElement("button", { id }, "Open"));
      act(() =>
        root.render(
          createElement(
            "div",
            null,
            createElement("main", null, card("other-pane")),
            createElement(
              "main",
              null,
              card("current-pane"),
              createElement(TurnSlot, { bot: dog, working: false, onOpenDog: vi.fn() }),
            ),
          ),
        ),
      );
      for (const node of host.querySelectorAll<HTMLElement>("section")) {
        node.getBoundingClientRect = () => ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 100,
          bottom: 20,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        });
        node.scrollIntoView = vi.fn();
      }
      act(() => host.querySelector<HTMLButtonElement>("[data-turn-slot] button")!.click());
      expect(document.activeElement?.id).toBe("current-pane");
    },
  );
});
