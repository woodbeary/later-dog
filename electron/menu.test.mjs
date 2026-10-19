import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "later.dog" },
  Menu: { buildFromTemplate: (template) => template },
}));

import { buildApplicationMenu } from "./menu.mjs";

describe("buildApplicationMenu", () => {
  const originalPlatform = process.platform;

  function withPlatform(platform, fn) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  }

  const build = (platform, overrides = {}) =>
    withPlatform(platform, () =>
      buildApplicationMenu({
        ...overrides,
      }),
    );

  it("macOS app menu wires an explicit Preferences item to the settings callback", () => {
    const onOpenSettings = vi.fn();
    const template = build("darwin", { onOpenSettings });
    const item = template[0].submenu.find((entry) => entry.label === "Preferences…");
    expect(item).toBeDefined();
    expect(item.accelerator).toBe("CmdOrCtrl+,");
    expect(item.click).toBeTypeOf("function");
    item.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "win32"])("does not add an app menu on %s", (platform) => {
    const template = build(platform);
    expect(template[0].role).toBe("fileMenu");
    for (const item of template) {
      expect(item.label).not.toBe("later.dog");
    }
  });

  it.each(["darwin", "linux", "win32"])("has no Server menu, pairing-link item or forget item on %s", platform => {
    const template = build(platform);
    expect(template.find(entry => entry.label === "Server")).toBeUndefined();
    expect(JSON.stringify(template.map(entry => entry.submenu ?? []).flat().map(entry => entry.label))).not.toMatch(/Pairing Link|Forget/);
    expect(template.map(entry => entry.role).filter(Boolean)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu"]);
  });

  it.each(["linux", "win32"])("leaves Ctrl+Shift+I to the dog's details on %s and opens DevTools with F12", platform => {
    const view = build(platform).find(entry => entry.role === "viewMenu");
    const devTools = view.submenu.find(entry => entry.role === "toggleDevTools");
    expect(devTools.accelerator).toBe("F12");
    expect(JSON.stringify(view.submenu)).not.toMatch(/Shift\+I/i);
  });

  it("keeps the standard View menu on macOS, where ⌘⌥I opens DevTools", () => {
    expect(build("darwin").find(entry => entry.role === "viewMenu").submenu).toBeUndefined();
  });
});
