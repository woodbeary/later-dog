// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MacScreenTileView } from "./MacScreenTile";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const screen = { botId: "rex", png: "AAA", mime: "image/jpeg", at: 1 };
const draw = (props: Partial<Parameters<typeof MacScreenTileView>[0]> = {}) => act(() => root.render(
  createElement(MacScreenTileView, { name: "Rex", busy: true, screen, onStop: () => {}, ...props }),
));

it("shows the newest frame of the Mac with the dog's name and a Stop button", () => {
  draw();
  const image = host.querySelector<HTMLImageElement>("[data-mac-screen] img");
  expect(image?.getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
  expect(host.querySelector("[data-mac-screen-pill]")?.textContent).toBe("Rex is using your Mac");
  expect(host.querySelector("[data-mac-screen-stop]")?.textContent).toBe("Stop");
  draw({ screen: { ...screen, png: "BBB", at: 2 } });
  expect(host.querySelector("[data-mac-screen] img")?.getAttribute("src")).toBe("data:image/jpeg;base64,BBB");
});

it("stops the dog's turn from the tile", () => {
  const onStop = vi.fn();
  draw({ onStop });
  act(() => host.querySelector<HTMLButtonElement>("[data-mac-screen-stop]")!.click());
  expect(onStop).toHaveBeenCalledTimes(1);
});

it("is gone when there is no frame or the dog is done", () => {
  draw({ screen: undefined });
  expect(host.querySelector("[data-mac-screen]")).toBeNull();
  draw({ busy: false });
  expect(host.querySelector("[data-mac-screen]")).toBeNull();
});
