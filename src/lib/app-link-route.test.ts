import { describe, expect, it } from "vitest";

import { APP_LINK_SETTINGS_SECTIONS } from "../../shared/app-link";
import { SETTINGS_PAGES } from "@/components/SettingsModal";
import { appLinkFromBridge, appLinkStep } from "./app-link-route";

const roster = {
  bots: [{ id: "boat" }, { id: "kite" }],
  groups: [{ id: "g-team" }, { id: "g-dm", dm: true }],
};

describe("app link routing", () => {
  it("opens a dog's one conversation, or a group chat", () => {
    expect(appLinkStep({ kind: "dog", id: "kite" }, roster)).toEqual({ kind: "select", id: "kite" });
    expect(appLinkStep({ kind: "dog", id: "g-team" }, roster)).toEqual({ kind: "select", id: "g-team" });
  });

  it("says Not found for a dog that is gone or not shared, and for a dog-to-dog exchange", () => {
    expect(appLinkStep({ kind: "dog", id: "gone" }, roster)).toEqual({ kind: "notFound" });
    expect(appLinkStep({ kind: "dog", id: "g-dm" }, roster)).toEqual({ kind: "notFound" });
  });

  it("opens a settings section, or the top of Settings when the section is not offered", () => {
    expect(appLinkStep({ kind: "settings", section: "usage" }, roster)).toEqual({ kind: "settings", section: "usage" });
    expect(appLinkStep({ kind: "settings", section: null }, roster)).toEqual({ kind: "settings", section: "general" });
  });

  it("drops anything from the bridge that does not parse", () => {
    expect(appLinkFromBridge("laterdog://chat/boat?thread=t1")).toEqual({ kind: "dog", id: "boat" });
    expect(appLinkFromBridge("laterdog://chat/")).toBeNull();
    expect(appLinkFromBridge(undefined)).toBeNull();
  });

  it("names every Settings page a link can open, and nothing else", () => {
    expect([...APP_LINK_SETTINGS_SECTIONS].sort()).toEqual(SETTINGS_PAGES.map((page) => page.id).sort());
  });
});
