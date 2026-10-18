import { describe, expect, it } from "vitest";

import { isActiveTurnRefusal, isRemoteScreenshotContention } from "./remote-desktop";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention";

describe("cloud computer contention", () => {
  it("retries only known transient contention, not permanent 409 failures", () => {
    expect(isRemoteScreenshotContention({ status: 409, message: "this bot's cloud computer is being changed — wait for it to finish" })).toBe(true);
    expect(isRemoteScreenshotContention({ status: 409, message: "the VPS is being prepared — try again shortly" })).toBe(true);
    for (const message of ["VPS is not configured", "The VPS computer is not ready", "Choose Cloud computer before changing or opening this cloud computer. Auto only checks existing computer state."]) {
      expect(isRemoteScreenshotContention({ status: 409, message })).toBe(false);
    }
    expect(isRemoteScreenshotContention({ status: 503, message: "this bot's cloud computer is being changed — wait for it to finish" })).toBe(false);
  });
  it("recognises the active-turn refusal as a wait, not a fault", () => {
    const message = CLOUD_COMPUTER_BUSY_ERROR;
    expect(isActiveTurnRefusal({ status: 409, message })).toBe(true);
    expect(isActiveTurnRefusal(new Error(message))).toBe(true);
    expect(isActiveTurnRefusal({ status: 409, message: `computer: ${message}` })).toBe(true);
    expect(isActiveTurnRefusal({ status: 503, message })).toBe(false);
    expect(isActiveTurnRefusal({ status: 409, message: "this bot's cloud computer is being changed — wait for it to finish" })).toBe(false);
    expect(isActiveTurnRefusal(null)).toBe(false);
  });
});
