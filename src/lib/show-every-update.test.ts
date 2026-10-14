import { describe, expect, it } from "vitest";

import { SHOW_EVERY_UPDATE_KEY, readShowEveryUpdate, setShowEveryUpdate, showEveryUpdate } from "./show-every-update";

function fakeStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
}

describe("Show every update", () => {
  it("is off until someone turns it on", () => {
    expect(readShowEveryUpdate(fakeStore())).toBe(false);
    expect(readShowEveryUpdate(fakeStore({ [SHOW_EVERY_UPDATE_KEY]: "0" }))).toBe(false);
    expect(readShowEveryUpdate(fakeStore({ [SHOW_EVERY_UPDATE_KEY]: "1" }))).toBe(true);
  });

  it("remembers the choice, and still honours it when storage refuses to save", () => {
    const store = fakeStore();
    setShowEveryUpdate(true, store);
    expect(store.data[SHOW_EVERY_UPDATE_KEY]).toBe("1");
    setShowEveryUpdate(false, store);
    expect(store.data[SHOW_EVERY_UPDATE_KEY]).toBe("0");

    const refusing = { getItem: () => null, setItem: () => { throw new Error("full"); } };
    setShowEveryUpdate(true, refusing);
    expect(showEveryUpdate()).toBe(true);
    setShowEveryUpdate(false, refusing);
    expect(showEveryUpdate()).toBe(false);
  });
});
