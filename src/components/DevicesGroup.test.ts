import { describe, expect, it } from "vitest";
import { deviceKind, orderedDevices, RECENT_DEVICE_DAYS, splitDevices } from "./DevicesGroup";

describe("signed-in devices", () => {
  it("tells phones, computers and browsers apart from their names", () => {
    expect(deviceKind("Safari on iPhone")).toBe("phone");
    expect(deviceKind("later.dog on Android")).toBe("phone");
    expect(deviceKind("Chrome on Mac")).toBe("computer");
    expect(deviceKind("Jacob's Windows laptop")).toBe("computer");
    expect(deviceKind("curl")).toBe("browser");
  });

  it("puts this device first, then the most recently active", () => {
    const devices = [
      { id: "a", label: "Old Mac", createdAt: 1, lastSeenAt: 10 },
      { id: "b", label: "iPhone", createdAt: 1, lastSeenAt: 30 },
      { id: "c", label: "This Mac", createdAt: 1, lastSeenAt: 5 },
    ];
    expect(orderedDevices(devices, "c").map((device) => device.id)).toEqual(["c", "b", "a"]);
    expect(orderedDevices(devices, null).map((device) => device.id)).toEqual(["b", "a", "c"]);
  });

  it("folds devices unused for two weeks, but never this one", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const devices = [
      { id: "phone", label: "iPhone", createdAt: 1, lastSeenAt: now - day },
      { id: "here", label: "This Mac", createdAt: 1, lastSeenAt: now - 90 * day },
      { id: "edge", label: "Chrome on Mac", createdAt: 1, lastSeenAt: now - RECENT_DEVICE_DAYS * day },
      { id: "old", label: "Old iPad", createdAt: 1, lastSeenAt: now - 30 * day },
    ];
    const { recent, older } = splitDevices(devices, "here", now);
    expect(recent.map((device) => device.id)).toEqual(["phone", "here", "edge"]);
    expect(older.map((device) => device.id)).toEqual(["old"]);
    expect(splitDevices(devices, null, now, 365).older).toEqual([]);
  });
});
