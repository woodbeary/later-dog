import { describe, expect, it } from "vitest";
import { coldViews } from "./cold-views.ts";

describe("reading a sleeping dog's folder from storage", () => {
  it("asks whether the computer sleeps once for a burst of lookups and keeps one view, with its caches, across them", async () => {
    let at = 0;
    let asked = 0;
    let made = 0;
    const view = coldViews(async () => { asked += 1; return true; }, async () => ({ id: ++made }), { now: () => at });
    const scope = { path: "dogs/fieldwork" };
    const first = await Promise.all([view(scope), view(scope), view(scope)]);
    at += 2_000;
    const later = await view(scope);
    expect(asked).toBe(1);
    expect(new Set([...first, later])).toEqual(new Set([{ id: 1 }]));
    at += 2_000;
    expect(await view(scope)).toEqual({ id: 1 });
    expect(asked).toBe(2);
    expect(made).toBe(1);
  });

  it("stops using storage as soon as the computer is found awake, and starts a fresh view after it sleeps again", async () => {
    let at = 0;
    let awake = false;
    let made = 0;
    const view = coldViews(async () => !awake, async () => ({ id: ++made }), { now: () => at });
    const scope = { path: "dogs/fieldwork" };
    expect(await view(scope)).toEqual({ id: 1 });
    awake = true;
    at += 5_000;
    expect(await view(scope)).toBeNull();
    awake = false;
    at += 5_000;
    expect(await view(scope)).toEqual({ id: 2 });
  });
});
