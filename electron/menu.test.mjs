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

  const environments = [{ id: "x", name: "X", origin: "http://localhost" }];
  const build = (platform, overrides = {}) =>
    withPlatform(platform, () =>
      buildApplicationMenu({
        environments,
        activeId: "x",
        onSwitch: vi.fn(),
        onAddFromClipboard: vi.fn(),
        onForget: vi.fn(),
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

  it.each(["darwin", "linux", "win32"])("adds a server only from a copied pairing link on %s", platform => {
    const onAddFromClipboard = vi.fn();
    const submenu = build(platform, { onAddFromClipboard }).find(entry => entry.label === "Server").submenu;
    expect(submenu.map(entry => entry.label)).toEqual(["This computer", "X — localhost", undefined, "Add Server from Copied Pairing Link…", "Forget “X”"]);
    submenu.find(entry => entry.label === "Add Server from Copied Pairing Link…").click();
    expect(onAddFromClipboard).toHaveBeenCalledOnce();
  });
});
