import { beforeEach, describe, expect, it } from "vitest";
import type { EffortLevel } from "../../shared/wire";
import type { InstanceInfo } from "@/state/store";
import { setLocale } from "./i18n";
import { chatContextFigure, chatContextReading, contextPercentWords } from "./chat-context";
import { chosenEffort, effortIsDefault } from "@/components/EffortPanel";

beforeEach(() => setLocale("en"));

describe("how full a chat is", () => {
  it("says nothing before a turn has reported its size", () => {
    expect(chatContextReading(undefined)).toBeNull();
    expect(chatContextReading({ tokens: 0, window: 200_000 })).toBeNull();
    expect(chatContextReading({ tokens: Number.NaN })).toBeNull();
  });

  it("measures against the window the turn reported, else the model's own", () => {
    expect(chatContextReading({ tokens: 50_000, window: 200_000 }, 1_000_000)).toMatchObject({ window: 200_000, percent: 25, level: "ok" });
    expect(chatContextReading({ tokens: 46_000 }, 1_000_000)).toMatchObject({ window: 1_000_000, level: "ok" });
    expect(chatContextReading({ tokens: 46_000 })).toEqual({ tokens: 46_000, window: null, percent: null, level: "ok" });
  });

  it("warns from three quarters full and stops at full", () => {
    expect(chatContextReading({ tokens: 150_000, window: 200_000 })?.level).toBe("near");
    expect(chatContextReading({ tokens: 260_000, window: 200_000 })).toMatchObject({ percent: 100, level: "over" });
  });

  it("reads as used of window and a share, never a bare zero for a little", () => {
    expect(chatContextFigure(chatContextReading({ tokens: 46_000 }, 1_000_000)!)).toBe("46k of 1M · 5%");
    expect(chatContextFigure(chatContextReading({ tokens: 12 }, 1_000_000)!)).toBe("12 of 1M · <1%");
    expect(chatContextFigure(chatContextReading({ tokens: 46_000 })!)).toBe("46k tokens");
    expect(contextPercentWords(0)).toBe("0%");
    expect(contextPercentWords(0.4)).toBe("<1%");
    expect(contextPercentWords(99.6)).toBe("100%");
  });
});

describe("the usual effort", () => {
  const levels: EffortLevel[] = ["low", "medium", "high", "max"];
  const engine = (defaultEffort?: EffortLevel): InstanceInfo => ({
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
    snapshot: { state: "available", authenticated: true },
    models: { default: "opus", options: [{ id: "opus", label: "Opus", ...(defaultEffort ? { defaultEffort } : {}) }] },
    capabilities: { effortLevels: levels },
  }) as InstanceInfo;

  it("is the model's own default, whether chosen or left unset", () => {
    expect(effortIsDefault(engine("medium"), "opus", undefined)).toBe(true);
    expect(effortIsDefault(engine("medium"), "opus", "medium")).toBe(true);
    expect(effortIsDefault(engine("medium"), "opus", "high")).toBe(false);
    expect(chosenEffort(engine("medium"), "opus", undefined)).toBe("medium");
  });

  it("fits a level the model does not offer to the nearest one below, and calls nothing unusual without a stated default", () => {
    expect(chosenEffort(engine("medium"), "opus", "xhigh")).toBe("high");
    expect(effortIsDefault(engine(), "opus", undefined)).toBe(true);
  });
});
