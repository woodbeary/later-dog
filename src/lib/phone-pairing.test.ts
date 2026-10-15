import { describe, expect, it } from "vitest";
import { pairedDestination, pairingCodesOn, takePhoneAppRequest } from "./phone-pairing";

describe("legacy phone settings requests", () => {
  it("opens the phone account instructions while removing the request from the address", () => {
    expect(takePhoneAppRequest("https://home.example/?desktop-settings=phone")).toBe("/");
    expect(takePhoneAppRequest("https://home.example/?a=1&desktop-settings=phone#x")).toBe("/?a=1#x");
    expect(takePhoneAppRequest("https://home.example/?desktop-settings=workspaces")).toBeNull();
    expect(takePhoneAppRequest("https://home.example/")).toBeNull();
  });
  it("preserves only the phone instructions destination after desktop server authentication", () => {
    expect(pairedDestination("?desktop-settings=phone")).toBe("/?desktop-settings=phone");
    expect(pairedDestination("?desktop-settings=phone&next=https://evil.example")).toBe("/?desktop-settings=phone");
    expect(pairedDestination("?desktop-settings=workspaces")).toBe("/");
    expect(pairedDestination("?next=//evil.example")).toBe("/");
  });
  it("retains the server's desktop pairing-code policy", () => {
    expect(pairingCodesOn({ membership: { pairingCodes: false } })).toBe(false);
    expect(pairingCodesOn({ membership: { pairingCodes: true } })).toBe(true);
    for (const config of [{}, null, undefined]) expect(pairingCodesOn(config)).toBe(true);
  });
});
