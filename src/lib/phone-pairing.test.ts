import { afterEach, describe, expect, it, vi } from "vitest";

import { currentPhonePairingTarget, pairedDestination, phonePairingTarget, takePhonePairingRequest } from "./phone-pairing";

afterEach(() => vi.unstubAllGlobals());

describe("where Connect your phone pairs", () => {
  it("pairs with this computer only in the desktop app's own window", () => {
    expect(phonePairingTarget({ companion: true, remoteClient: false, cloudHome: false })).toBe("computer");
    // a remote server's page never gets the phone bridge; a browser has none
    expect(phonePairingTarget({ companion: false, remoteClient: false, cloudHome: false })).toBe("server");
    // a desktop that is a client of another server pairs phones there
    expect(phonePairingTarget({ companion: true, remoteClient: true, cloudHome: false })).toBe("server");
  });

  it("pairs with the Cloud wherever the window shows the person's own Cloud", () => {
    expect(phonePairingTarget({ companion: false, remoteClient: false, cloudHome: true })).toBe("cloud");
    expect(phonePairingTarget({ companion: true, remoteClient: true, cloudHome: true })).toBe("cloud");
    // the server answering says it is a Cloud home: its pairing is the Cloud's, whatever bridge this page has
    expect(phonePairingTarget({ companion: true, remoteClient: false, cloudHome: true })).toBe("cloud");
  });

  it("reads the window's bridges", () => {
    vi.stubGlobal("window", { laterdog: { companion: {} } });
    expect(currentPhonePairingTarget(false)).toBe("computer");
    vi.stubGlobal("window", { laterdog: { companion: {}, remoteClient: { active: true } } });
    expect(currentPhonePairingTarget(false)).toBe("server");
    // the reduced bridge a Cloud page gets: no companion
    vi.stubGlobal("window", { laterdog: { cloudPlan: {} } });
    expect(currentPhonePairingTarget(true)).toBe("cloud");
    // a browser
    vi.stubGlobal("window", {});
    expect(currentPhonePairingTarget(false)).toBe("server");
  });
});

describe("the ?desktop-settings=phone request", () => {
  it("is taken off the address, keeping everything else", () => {
    expect(takePhonePairingRequest("https://home.fly.dev/?desktop-settings=phone")).toBe("/");
    expect(takePhonePairingRequest("https://home.fly.dev/?a=1&desktop-settings=phone#x")).toBe("/?a=1#x");
    expect(takePhonePairingRequest("https://home.fly.dev/?desktop-settings=workspaces")).toBeNull();
    expect(takePhonePairingRequest("https://home.fly.dev/")).toBeNull();
  });

  it("survives pairing, and nothing else does", () => {
    expect(pairedDestination("?desktop-settings=phone")).toBe("/?desktop-settings=phone");
    expect(pairedDestination("?desktop-settings=phone&next=https://evil.example")).toBe("/?desktop-settings=phone");
    expect(pairedDestination("?desktop-settings=workspaces")).toBe("/");
    expect(pairedDestination("?next=//evil.example")).toBe("/");
    expect(pairedDestination("")).toBe("/");
  });
});
