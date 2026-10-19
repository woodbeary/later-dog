import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import {
  cloudRefusal, PLACE_EN, PLACE_STATES, PLACE_WORDS, placeRowText, placeRowView, placeViewOf,
  type PlaceParams, type PlaceSource, type PlaceState,
} from "./place-view.ts";

const PARAMS: PlaceParams = {
  bot: "Scout", engine: "Claude", model: "Llama", computer: "Team desk", hours: 50, month: "November",
  plan: "Pro", max: 2, holders: ["Ada", "Bo"], words: "Start the Boat plan to create sandboxes.", reason: "CUA Driver is not ready.",
  cause: "the Local VM is not ready",
};

describe("U1: one line and at most one action for every state", () => {
  it("words every state whole, for an Admin and for a User", () => {
    for (const state of PLACE_STATES) {
      for (const role of ["admin", "user"] as const) {
        const view = placeViewOf(state, PARAMS, { role, server: "my-cloud" });
        expect(view.short.trim(), state).not.toBe("");
        expect(view.line.trim(), state).not.toBe("");
        expect(view.line, state).not.toMatch(/\n|\{\w+\}/);
        expect(view.short, state).not.toMatch(/\{\w+\}/);
        if (view.action) expect(view.action.label, state).not.toMatch(/^$|\{\w+\}/);
      }
    }
  });

  it("gives a User no action that changes a setting, and says who can", () => {
    for (const state of PLACE_STATES) {
      const admin = placeViewOf(state, PARAMS, { role: "admin", server: "my-cloud" });
      const user = placeViewOf(state, PARAMS, { role: "user", server: "my-cloud" });
      if (!admin.action || admin.action.id === "try-again" || admin.action.id === "watch" || admin.action.id === "clear-pin" || admin.action.id === "open-computer-panel") {
        expect(user, state).toEqual(admin);
        continue;
      }
      if (admin.action.id === "start" || admin.action.id === "wake") {
        expect(user, state).toEqual({ ...admin, action: null });
        continue;
      }
      expect(user.action, state).toBeNull();
      expect(user.line, state).toBe(`${admin.line} Ask an Admin to change it.`);
    }
  });

  it("mirrors en.json exactly, key for key", () => {
    const catalog = en as Record<string, string>;
    for (const [key, value] of Object.entries(PLACE_EN)) expect(catalog[key], key).toBe(value);
    const mirrored = new Set(Object.keys(PLACE_EN));
    const inCatalog = Object.keys(catalog).filter((key) => /^place\.(view|action)\./.test(key) || key === "place.askAdmin" || key === "place.backOnAuto");
    expect(inCatalog.filter((key) => !mirrored.has(key))).toEqual([]);
  });

  it("keeps jargon out of what subscribers read", () => {
    for (const state of PLACE_STATES) {
      const view = placeViewOf(state, { ...PARAMS, words: "x" }, { role: "admin", server: "my-cloud" });
      const words = `${view.short} ${view.line} ${view.action?.label ?? ""}`;
      expect(words, state).not.toMatch(/Boat/);
      expect(words, state).not.toMatch(/\bbox\b|\blaterdog\b|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
      if (state.startsWith("cc-")) expect(words, state).not.toMatch(/\bVM\b/);
    }
    for (const [id, sentence] of Object.entries(PLACE_WORDS)) {
      expect(sentence, id).not.toMatch(/\bbox\b|\blaterdog\b|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
      expect(sentence, id).not.toMatch(/Boat/);
    }
  });

  it("uses the plan's state table copy", () => {
    const admin = { role: "admin" as const, server: "my-cloud" as const };
    expect(placeViewOf("cc-no-hours", { hours: 50, month: "November" }, admin)).toMatchObject({
      short: "No hours left", line: "This month's 50 cloud computer hours are used up. They come back on 1 November.",
      action: { id: "see-plan", label: "See your plan" },
    });
    expect(placeViewOf("cc-at-once", { plan: "Personal", max: 1, holders: ["Ada"] }, admin).line)
      .toBe("Your Personal plan includes 1 cloud computer, and Ada has it.");
    expect(placeViewOf("cc-at-once", { plan: "Pro", max: 2, holders: ["Ada", "Bo"] }, admin).line)
      .toBe("Your Pro plan includes 2 cloud computers, and Ada and Bo have them.");
    expect(placeViewOf("cc-at-once", { plan: "Pro", max: 2 }, admin).line).toBe("All the cloud computers your plan includes are in use.");
    expect(placeViewOf("cc-no-hours", {}, admin).line).toBe("This month's cloud computer hours are used up.");
    expect(placeViewOf("cc-unavailable", {}, admin)).toMatchObject({
      short: "Not available now", line: "Cloud computers can't start right now. It isn't anything you did.", action: { id: "try-again" },
    });
    expect(placeViewOf("cc-on-my-cloud", {}, { role: "admin", server: "mac" })).toMatchObject({
      line: "Cloud computers from your plan work for dogs on My Cloud for now.", action: { id: "open-my-cloud", label: "Open My Cloud" },
    });
    expect(placeViewOf("auto", {}, { role: "admin", server: "mac" }).line)
      .toBe("Picks its cloud computer or this computer when a task needs one.");
    expect(placeViewOf("cc-provider", { bot: "Scout", words: "No capacity in this region." }, admin))
      .toMatchObject({ short: "Couldn't start", line: "Scout's cloud computer couldn't start: No capacity in this region." });
    expect(placeViewOf("cc-needs-key", {}, { role: "admin", server: "mac" })).toMatchObject({
      short: "Not set up", line: "Cloud computers aren’t set up here yet.", action: null,
    });
  });
});

describe("a failed place, by where it came from", () => {
  const row = (source: PlaceSource, state: PlaceState = "cc-unavailable") => ({ state, params: { bot: "Scout" }, source });

  it("has its own way on per source for a passing cause", () => {
    const view = (source: PlaceSource, worksOnLabel?: string) =>
      placeRowView(row(source), { role: "admin", worksOnLabel });
    expect(view("works-on").action).toEqual({ id: "try-again", label: "Try again" });
    expect(view("pin").action).toEqual({ id: "clear-pin", label: "Clear this conversation's place" });
    expect(view("pin", "Auto").action).toEqual({ id: "clear-pin", label: "Use Auto" });
    expect(view("auto-pin")).toMatchObject({ line: "Cloud computers can't start right now. It isn't anything you did. This conversation is back on Auto.", action: { id: "try-again" } });
    expect(view("routine").action).toEqual({ id: "change-routine", label: "Change where it runs" });
    expect(view("room").action).toBeNull();
  });

  it("keeps a cause's own fix whatever the source", () => {
    for (const source of ["works-on", "pin", "auto-pin", "routine", "room"] as const) {
      expect(placeRowView(row(source, "cc-no-hours"), { role: "admin" }).action?.id, source).toBe("see-plan");
    }
  });

  it("stores the line and its action as words a phone can read", () => {
    expect(placeRowText({ state: "cc-no-hours", params: { bot: "Scout", hours: 50, month: "November" }, source: "works-on" }))
      .toBe("This month's 50 cloud computer hours are used up. They come back on 1 November. See your plan on the Plan page.");
    expect(placeRowText(row("auto-pin")))
      .toBe("Cloud computers can't start right now. It isn't anything you did. This conversation is back on Auto. Send your message again.");
    expect(placeRowText(row("routine"))).toBe("Cloud computers can't start right now. It isn't anything you did. Change where this routine runs.");
    expect(placeRowText(row("room"))).toBe("Cloud computers can't start right now. It isn't anything you did.");
    expect(placeRowText({ state: "cc-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" }))
      .toBe("Llama can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
  });
});

describe("cloudRefusal reads the Admin's refusals", () => {
  const included = (message: string, code?: string, status?: number) => cloudRefusal({ message, code, status }, true);

  it("reads today's English, before the Admin sends its own codes", () => {
    expect(included("Your Pro plan's 50 cloud computer hours for October are used up. They reset on 1 November.", "limit_reached", 429))
      .toEqual({ state: "cc-no-hours", params: { plan: "Pro", hours: 50, month: "November" } });
    expect(included("Your Personal plan includes 1 cloud computer at once. Delete one to start another.", "limit_reached", 429))
      .toEqual({ state: "cc-at-once", params: { plan: "Personal", max: 1 } });
    expect(included("Your cloud computers were started too often. Try again in a minute.", "limit_reached", 429).state).toBe("cc-unavailable");
    expect(included("Cloud computers are busy right now. Try again in a few minutes.", "rate_limited", 429).state).toBe("cc-unavailable");
    expect(included("Cloud computers are temporarily unavailable. Try again later.", undefined, 503).state).toBe("cc-unavailable");
  });

  it("maps the existing inactive-plan code, and the codes the Admin is adding", () => {
    expect(included("Cloud computers are included with an active Cloud subscription.", "subscription_inactive", 402).state).toBe("cc-ended");
    expect(included("x", "hours_used").state).toBe("cc-no-hours");
    expect(included("x", "at_once").state).toBe("cc-at-once");
    expect(included("x", "too_many_starts").state).toBe("cc-unavailable");
  });

  it("reads this app's own start failures, and an own key's provider words", () => {
    expect(included("box did not become ready within 90s — retry in a minute").state).toBe("cc-no-start");
    expect(included("box desktop link could not be created").state).toBe("cc-no-start");
    expect(included("this cloud computer is being deleted — wait for it to finish, or retry Delete if it needs attention").state).toBe("cc-clearing");
    expect(cloudRefusal({ message: "Start the $20/month Boat plan to create sandboxes.", status: 402 }, false))
      .toEqual({ state: "cc-provider", params: { words: "Start the $20/month Boat plan to create sandboxes." } });
    expect(included("something new").state).toBe("cc-no-start");
  });
});
