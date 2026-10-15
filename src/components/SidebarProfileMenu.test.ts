import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const menu = vi.hoisted(() => ({ items: [] as SidebarMenuItem[], instances: [] as InstanceInfo[], dispatch: vi.fn(), updater: null as UpdaterState | null }));
vi.mock("./SidebarPopoverMenu", () => ({
  SidebarPopoverMenu: ({ items }: { items: SidebarMenuItem[] }) => {
    menu.items = items;
    return null;
  },
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: menu.instances, config: { profile: { name: "Anthony" } } }, dispatch: menu.dispatch }),
  };
});
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => menu.updater }));

import {
  profileInitials,
  profileLabel,
  SidebarProfileMenu,
  updateBusy,
  updateLabel,
  updatePhase,
} from "./SidebarProfileMenu";
import { APP_REPOSITORY, DOCS_URL, FEEDBACK_URL, HELP_CENTER_URL, platformLabel } from "@/lib/app-links";
import type { UpdaterState } from "@/lib/updater";
import { dismissUpdateDialog, updateDialogOpen } from "@/lib/update-request";
import type { InstanceInfo } from "@/state/store";

const state = (patch: Partial<UpdaterState>): UpdaterState => ({ status: "idle", ...patch }) as UpdaterState;

describe("profileInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(profileInitials({ name: "Sam Reed" })).toBe("SR");
    expect(profileInitials({ name: "Ada Byron Lovelace" })).toBe("AB");
  });

  it("falls back to the email, then to a placeholder", () => {
    expect(profileInitials({ email: "you@x.dev" })).toBe("Y");
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });

  it("ignores whitespace-only names", () => {
    expect(profileInitials({ name: "   ", email: "you@x.dev" })).toBe("Y");
  });
});

describe("profileLabel", () => {
  it("prefers the name, then the email, then You", () => {
    expect(profileLabel({ name: "Alex", email: "o@x.dev" })).toBe("Alex");
    expect(profileLabel({ email: "o@x.dev" })).toBe("o@x.dev");
    expect(profileLabel(undefined)).toBe("You");
  });
});

describe("updatePhase", () => {
  it("reports the bridge's own in-flight states", () => {
    expect(updatePhase(state({ status: "checking" }), false)).toBe("checking");
    expect(updatePhase(state({ status: "downloading" }), false)).toBe("downloading");
    expect(updatePhase(state({ status: "preparing" }), false)).toBe("preparing");
    expect(updatePhase(state({ status: "installing" }), false)).toBe("installing");
  });

  it("acknowledges a check that found nothing", () => {
    expect(updatePhase(null, true)).toBe("up-to-date");
    expect(updatePhase(null, false)).toBe("idle");
  });

  it("lets a real status outrank the acknowledgement", () => {
    expect(updatePhase(state({ status: "downloading" }), true)).toBe("downloading");
  });
});

describe("updateLabel", () => {
  it("names the version it is ready to install", () => {
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0" }))).toBe(
      "later.dog 0.2.0 ready — restart",
    );
  });

  it("shows progress only once there is a percentage", () => {
    expect(updateLabel("downloading", state({ status: "downloading" }))).toBe("Starting download…");
    expect(updateLabel("downloading", state({ status: "downloading", percent: 41.6 }))).toBe("Downloading… 42%");
  });

  it("distinguishes native preparation from restart readiness", () => {
    expect(updateLabel("preparing", state({ status: "preparing", percent: 100 }))).toBe("Preparing update…");
    expect(updateLabel("installing", state({ status: "installing", message: "Restart is taking longer than expected." })))
      .toBe("Restart is taking longer than expected.");
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0", installMode: "handoff" })))
      .toBe("later.dog 0.2.0 ready — install");
    expect(updateLabel("installing", state({ status: "installing", installMode: "handoff" })))
      .toBe("Opening a terminal…");
  });

  it("carries the updater's own message when something failed", () => {
    expect(updateLabel("error", state({ status: "error", message: "Network unreachable" }))).toBe(
      "Network unreachable",
    );
    expect(updateLabel("error", state({ status: "error" }))).toBe("Update failed — try again");
  });

  it("points a hand-off at the terminal that finishes it", () => {
    expect(updateLabel("handed-off", state({ status: "handed-off" }))).toBe(
      "Finish the update in your terminal",
    );
  });

  it("defaults to the invitation to check", () => {
    expect(updateLabel("idle", null)).toBe("Check for updates");
    expect(updateLabel("up-to-date", null)).toBe("You're up to date");
  });
});

describe("updateBusy", () => {
  it("blocks clicks while something is in flight", () => {
    expect(updateBusy("checking")).toBe(true);
    expect(updateBusy("downloading")).toBe(true);
    expect(updateBusy("preparing")).toBe(true);
    expect(updateBusy("installing")).toBe(true);
    expect(updateBusy("downloaded")).toBe(false);
    expect(updateBusy("idle")).toBe(false);
  });

  it("blocks the gap between the click and the bridge catching up", () => {
    expect(updateBusy("downloaded", true)).toBe(true);
    expect(updateBusy("error", true)).toBe(true);
  });
});

describe("platformLabel", () => {
  it("names the platforms we ship, and stays quiet otherwise", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });
});

describe("outward links", () => {
  it("sends Help Center to this project's own docs", () => {
    expect(APP_REPOSITORY).toBe("https://github.com/woodbeary/later-dog");
    expect(HELP_CENTER_URL).toBe(DOCS_URL);
    expect(DOCS_URL).toBe("https://github.com/woodbeary/later-dog/tree/main/docs/laterdog");
  });

  it("sends Send Feedback to this project's issue tracker, not to anyone else's community", () => {
    expect(FEEDBACK_URL).toBe("https://github.com/woodbeary/later-dog/issues");
  });
});

describe("the menu under your name", () => {
  const claude = {
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
    snapshot: { state: "available", authenticated: true }, models: { default: "", options: [] },
    authentication: { method: "paste-code", signOut: true },
  } as InstanceInfo;
  const open = (laterdog?: Record<string, unknown>) => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {}, ...(laterdog ? { laterdog } : {}) });
    try {
      renderToStaticMarkup(createElement(SidebarProfileMenu));
      return menu.items;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  beforeEach(() => {
    menu.instances = [];
    menu.updater = null;
    menu.dispatch.mockReset();
  });

  it("offers the iPhone app above Settings when nothing here is signed in, and no phone pairing", () => {
    const items = open();
    expect(items.map((item) => item.key)).toEqual(["phoneApp", "settings", "plugins"]);
    expect(items[0]).toMatchObject({ label: "Get later.dog for iPhone" });
    expect(items.map((item) => item.label).join(" ")).not.toMatch(/connect your phone|pair/i);
    items[1]!.onSelect();
    expect(menu.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings" });
  });

  it("ends with Add account under a line once an account here is signed in, and never offers to sign Claude or ChatGPT out here", () => {
    menu.instances = [claude, { ...claude, instanceId: "claude-api", authentication: { method: "paste-code" } } as InstanceInfo];
    const items = open();
    expect(items.map((item) => item.key)).toEqual(["phoneApp", "settings", "plugins", "add-account"]);
    expect(items[3]).toMatchObject({ label: "Add account", separatorBefore: true });
    menu.instances = [{ ...claude, snapshot: { state: "available", authenticated: false } } as InstanceInfo];
    expect(open().map((item) => item.key)).toEqual(["phoneApp", "settings", "plugins"]);
  });

  it("adds a New update available row with Install when an update is ready, and stays quiet otherwise", () => {
    const updater = { updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() } };
    menu.updater = { status: "downloaded", version: "0.2.0" } as UpdaterState;
    const [ready, , settings] = open(updater);
    expect(ready).toMatchObject({ key: "update-available", label: "New update available" });
    expect(renderToStaticMarkup(ready!.trailing as never)).toContain(">Install<");
    expect(settings).toMatchObject({ key: "settings" });
    expect(settings).not.toHaveProperty("note");
    expect(updateDialogOpen()).toBe(false);
    ready!.onSelect();
    expect(updateDialogOpen()).toBe(true);
    dismissUpdateDialog();

    menu.updater = { status: "idle", releaseCheck: "on", available: { version: "0.2.0", url: "https://example.test" } } as UpdaterState;
    const [offer] = open(updater);
    expect(offer).toMatchObject({ key: "update-available" });
    expect(renderToStaticMarkup(offer!.trailing as never)).toContain(">Download<");

    for (const quiet of [{ status: "error", message: "offline" }, { status: "idle" }, { status: "downloading", percent: 3 }] as UpdaterState[]) {
      menu.updater = quiet;
      expect(open(updater).map((item) => item.key)).toEqual(["phoneApp", "settings", "plugins"]);
    }
    menu.updater = { status: "downloaded", version: "0.2.0" } as UpdaterState;
    open(updater).find((item) => item.key === "settings")!.onSelect();
    expect(menu.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings" });
  });
});
