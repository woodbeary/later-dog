import { afterEach, describe, expect, it, vi } from "vitest";
import { giveTreat, onTreat, treatCount } from "./treats";

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
};

afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("treats", () => {
  it("counts treats per dog and tells listeners", () => {
    vi.stubGlobal("localStorage", storage);
    const heard = vi.fn();
    const stop = onTreat(heard);
    expect(treatCount("otto")).toBe(0);
    expect(giveTreat("otto")).toBe(1);
    expect(giveTreat("otto")).toBe(2);
    expect(giveTreat("scout")).toBe(1);
    expect(treatCount("otto")).toBe(2);
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    giveTreat("otto");
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("keeps the dog happy when storage is blocked or holds garbage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(treatCount("otto")).toBe(0);
    expect(giveTreat("otto")).toBe(1);
    vi.stubGlobal("localStorage", { getItem: () => "lots", setItem: () => {} });
    expect(treatCount("otto")).toBe(0);
  });
});
