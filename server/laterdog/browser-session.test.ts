import { afterEach, describe, expect, it, vi } from "vitest";
import { browserRestoreKey, browserSessionId } from "../browser-engine.ts";
import { desktopProfileSession } from "./browser-session.ts";

describe("browser sessions in a desktop profile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps Personal's session names as they are", () => {
    vi.stubEnv("LATERDOG_DESKTOP_PROFILE", "");
    expect(desktopProfileSession("work", {})).toBe("work");
    expect(browserSessionId("b1", "work")).toBe("work");
    expect(browserSessionId("b1", "")).toBe("bot-b1");
  });

  it("gives a profile's shared browsers names no other profile uses", () => {
    vi.stubEnv("LATERDOG_DESKTOP_PROFILE", "p00000000000a");
    expect(browserSessionId("b1", "work")).toBe("p00000000000a.work");
    expect(browserSessionId("b1", "")).toBe("bot-b1");
    expect(browserSessionId("b1", "guest")).toMatch(/^guest-[0-9a-f-]{36}$/);
    expect(browserRestoreKey(browserSessionId("b1", "work"))).not.toBe(browserRestoreKey("work"));
  });

  it("ignores a profile id that is not one later.dog made", () => {
    for (const value of ["main", "../x", "P00000000000A", "p00000000000a.work", "p0000000000a"]) {
      expect(desktopProfileSession("work", { LATERDOG_DESKTOP_PROFILE: value })).toBe("work");
    }
  });

  it("keeps the longest shared browser name whole", () => {
    vi.stubEnv("LATERDOG_DESKTOP_PROFILE", "p00000000000a");
    const longest = "x".repeat(40);
    expect(browserSessionId("b1", longest)).toBe(`p00000000000a.${longest}`);
  });
});
