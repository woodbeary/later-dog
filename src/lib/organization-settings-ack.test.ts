import { describe, expect, it, vi } from "vitest";
import { acknowledgeOrganizationSettings } from "./organization-settings-ack";

describe("acknowledgeOrganizationSettings", () => {
  it("clears the restart intent when Settings opens for an organization request", () => {
    const bridge = { settingsOpened: vi.fn().mockResolvedValue(true) };
    acknowledgeOrganizationSettings("organization", bridge, false);
    expect(bridge.settingsOpened).toHaveBeenCalledExactlyOnceWith();
  });

  it("leaves other Settings requests alone", () => {
    const bridge = { settingsOpened: vi.fn().mockResolvedValue(true) };
    for (const section of ["cloud", "cloud-settings", "workspaces", undefined, null]) acknowledgeOrganizationSettings(section, bridge, false);
    expect(bridge.settingsOpened).not.toHaveBeenCalled();
  });

  it("never acknowledges from a companion window", () => {
    const bridge = { settingsOpened: vi.fn().mockResolvedValue(true) };
    acknowledgeOrganizationSettings("organization", bridge, true);
    expect(bridge.settingsOpened).not.toHaveBeenCalled();
  });

  it("swallows a failed acknowledgement and tolerates a missing bridge", async () => {
    const bridge = { settingsOpened: vi.fn().mockRejectedValue(new Error("fixture write failure")) };
    expect(() => acknowledgeOrganizationSettings("organization", bridge, false)).not.toThrow();
    expect(() => acknowledgeOrganizationSettings("organization", undefined, false)).not.toThrow();
    expect(() => acknowledgeOrganizationSettings("organization", {}, false)).not.toThrow();
    await Promise.resolve();
  });
});
