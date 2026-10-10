import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readTheme, themeOptions } from "./theme";

let dark = false;
let listeners: Array<() => void> = [];
const bridge = vi.fn(() => Promise.resolve(true));

const flip = (value: boolean) => {
  dark = value;
  for (const listener of listeners) listener();
};

beforeEach(() => {
  const store = new Map<string, string>();
  dark = false;
  listeners = [];
  bridge.mockClear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.stubGlobal("document", { documentElement: { dataset: {} as DOMStringMap } });
  vi.stubGlobal("window", { laterdog: { applySkin: bridge } });
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return dark; },
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_: string, listener: () => void) => { listeners = listeners.filter((each) => each !== listener); },
  }));
});

describe("theme", () => {
  it("follows the system on a fresh install", () => {
    expect(readTheme()).toBe("system");
    applyTheme(readTheme());
    expect(document.documentElement.dataset.skin).toBe("daylight");
    expect(localStorage.getItem("laterdog-skin")).toBe("system");
  });

  it("repaints when the computer switches between light and dark", () => {
    applyTheme("system");
    flip(true);
    expect(document.documentElement.dataset.skin).toBe("midnight");
    flip(false);
    expect(document.documentElement.dataset.skin).toBe("daylight");
    expect(readTheme()).toBe("system");
  });

  it("stops following the system once Light or Dark is picked", () => {
    applyTheme("system");
    applyTheme("midnight");
    flip(false);
    expect(listeners).toEqual([]);
    expect(document.documentElement.dataset.skin).toBe("midnight");
    expect(readTheme()).toBe("midnight");
  });

  it("tells the desktop window the skin it painted, never system", () => {
    dark = true;
    applyTheme("system");
    expect(bridge).toHaveBeenLastCalledWith("midnight");
  });

  it("keeps a skin picked before the menu, as one extra choice", () => {
    localStorage.setItem("laterdog-skin", "atelier");
    expect(readTheme()).toBe("atelier");
    expect(themeOptions("atelier")).toEqual(["system", "daylight", "midnight", "atelier"]);
    expect(themeOptions("daylight")).toEqual(["system", "daylight", "midnight"]);
  });

  it("follows the system when the stored value is unknown", () => {
    localStorage.setItem("laterdog-skin", "comic-sans");
    expect(readTheme()).toBe("system");
  });
});
