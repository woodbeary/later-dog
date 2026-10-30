import { describe, expect, it } from "vitest";
import { deviceKind, orderedDevices } from "./DevicesGroup";

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
});
