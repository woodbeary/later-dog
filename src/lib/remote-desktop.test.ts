import { describe, expect, it } from "vitest";

import { isActiveTurnRefusal } from "./remote-desktop";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention";

describe("cloud computer contention", () => {
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
