import { describe, expect, it } from "vitest";

import {
  cloudPlaceRefusal,
  computerToolsRefusal,
  parseSurface,
  placeUnavailable,
  resolveSurface,
  surfaceOfComputerKind,
  surfacePrompt,
} from "./surface.ts";

const AUTO = { computer: undefined, browser: false, pinned: null, note: "" };

describe("resolveSurface", () => {
  it("reads a retired Local VM or browser as Auto, pinned or not", () => {
    for (const retired of ["vm", "browser"] as const) {
      expect(resolveSurface({ destination: retired, browserOn: false })).toEqual(AUTO);
      expect(resolveSurface({ destination: undefined, pinnedSurface: retired, browserOn: false })).toEqual(AUTO);
    }
  });

  it("a computer destination mounts only that computer: one place per turn", () => {
    for (const destination of ["cloud", "local"] as const) {
      expect(resolveSurface({ destination, browserOn: true })).toEqual({ computer: destination, browser: false, pinned: null, note: "" });
      expect(resolveSurface({ destination, browserOn: false })).toMatchObject({ computer: destination, browser: false });
    }
  });

  it("Off mounts no computer, and says which setting did it", () => {
    const plan = resolveSurface({ destination: "off", browserOn: true });
    expect(plan).toMatchObject({ computer: "off", browser: false, pinned: null });
    expect(plan.note).toMatch(/"Works on" setting is Off/);
    expect(plan.note).toMatch(/no computer is mounted/);
    expect(resolveSurface({ destination: "off", browserOn: false })).toEqual(plan);
    expect(surfacePrompt({ computer: null, browser: false }, { note: plan.note })).toBe(plan.note);
  });

  it("Off is the one setting a conversation pin cannot override", () => {
    for (const pin of ["cloud", "local"] as const) {
      expect(resolveSurface({ destination: "off", pinnedSurface: pin, browserOn: true }))
        .toMatchObject({ computer: "off", browser: false, pinned: null });
    }
  });

  it("a conversation pin wins over the bot's default, whatever that default is", () => {
    for (const destination of ["cloud", "local", undefined] as const) {
      for (const pin of ["cloud", "local"] as const) {
        expect(resolveSurface({ destination, pinnedSurface: pin, browserOn: false }))
          .toEqual({ computer: pin, browser: false, pinned: pin, note: "" });
      }
    }
  });

  it("Auto without a pin leaves the computer to the dispatch", () => {
    expect(resolveSurface({ destination: undefined, browserOn: false })).toEqual(AUTO);
  });
});

describe("surfacePrompt", () => {
  it("names the computer, its browser included", () => {
    const text = surfacePrompt({ computer: "cloud", browser: false });
    expect(text).toMatch(/happens on the cloud computer, web pages included, through its own browser/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).not.toMatch(/Two surfaces|built-in browser|Local VM/);
    expect(surfacePrompt({ computer: "local", browser: false })).toMatch(/tell them it is on this computer/);
  });

  it("explains unavailable tools, and carries the pin line and the note", () => {
    expect(surfacePrompt({ computer: null, browser: false })).toContain("No computer tools are mounted this turn");
    expect(surfacePrompt({ computer: "cloud", browser: false }, { pinned: "cloud" }))
      .toContain("This conversation is pinned to the cloud computer; changing places requires");
    expect(surfacePrompt({ computer: null, browser: false }, { note: " NOTE." })).toBe(" NOTE.");
  });

  it.each(["local", "cloud"] as const)("requires observed results on the actual %s tools", (computer) => {
    const text = surfacePrompt({ computer, browser: false });
    expect(text).toContain("verify its result before claiming success");
    expect(text).toContain("Announcing an action is not performing it");
    expect(text).toContain("never act on a different computer.");
    expect(text).toContain("use later.dog's mounted computer tools first");
    expect(text).toContain("Do not substitute the provider's own desktop");
    expect(text).toContain("use the computer's browser when a search service is unavailable");
  });

  it("chooses and starts configured targets through chat instead of requiring menu nudges", () => {
    const text = surfacePrompt({ computer: null, browser: false }, { canSelect: true });
    expect(text).toContain("use select_computer with no arguments");
    expect(text).toContain("surface auto instead of asking them to operate the menu");
    expect(text).toContain("highlight the selected target");
    expect(text).toContain("then you must carry out the task");
    expect(text).not.toContain("ask the user to choose and connect a computer");
    expect(text).not.toMatch(/Local VM|\bVM\b|built-in browser/);
  });

  it("keeps explicit destinations and uses a turn-bound switch when supported", () => {
    const text = surfacePrompt({ computer: "local", browser: false }, { pinned: "local", canSelect: true });
    expect(text).toContain("select the requested available place");
    expect(text).toContain("changing places requires select_computer");
    expect(text).not.toContain("ask the user to change where this conversation works");
    expect(text).not.toMatch(/\bVM\b/);
  });

  it("sends the person to the Computer panel, the place control both interface modes show", () => {
    const text = surfacePrompt({ computer: "cloud", browser: false }, { pinned: "cloud" });
    expect(text).toContain("explain the mismatch and ask the user to change where this conversation works in the Computer panel");
    expect(text).toContain("changing places requires the user's choice in the Computer panel, not a different tool name");
    expect(text).not.toContain("computer selector");
  });

  const shapes = ([{ computer: "cloud", browser: false }, { computer: null, browser: false }] as Array<{ computer: "cloud" | null; browser: boolean }>)
    .flatMap((mounted) => ([{}, { canSelect: true }, { canSelect: true, pinned: "cloud" }] as Array<{ canSelect?: boolean; pinned?: "cloud" }>)
      .map((opts) => ({ mounted, opts })));

  it("tells a Cloud home's bots only about the places it has", () => {
    for (const { mounted, opts } of shapes) {
      const text = surfacePrompt(mounted, { ...opts, cloudHome: true });
      expect(text, JSON.stringify({ mounted, opts })).not.toMatch(/Local VM|\bVM\b|host desktop|user's host|host window|built-in browser|this computer is/);
      if (mounted.computer) {
        expect(text).toContain("the cloud computer is the dog's own computer and the user's own computer cannot be reached from here");
        expect(text).toContain("never act on a different computer.");
      }
    }
  });

  it("leaves every other server's paragraph exactly as it was", () => {
    for (const { mounted, opts } of shapes) {
      expect(surfacePrompt(mounted, { ...opts, cloudHome: false })).toBe(surfacePrompt(mounted, opts));
    }
    expect(surfacePrompt({ computer: "cloud", browser: false }, { canSelect: true }))
      .toContain("this computer is the user's own computer and the cloud computer is the dog's own computer in the cloud");
  });
});

describe("surface parsing", () => {
  it("accepts only the four surfaces off the wire", () => {
    expect(parseSurface("browser")).toBe("browser");
    expect(parseSurface("cloud")).toBe("cloud");
    expect(parseSurface("box")).toBeUndefined();
    expect(parseSurface(42)).toBeUndefined();
    expect(parseSurface(undefined)).toBeUndefined();
  });

  it("folds both cloud backends into one surface", () => {
    expect(surfaceOfComputerKind("box")).toBe("cloud");
    expect(surfaceOfComputerKind("vps")).toBe("cloud");
    expect(surfaceOfComputerKind("vm")).toBe("vm");
    expect(surfaceOfComputerKind("local")).toBe("local");
    expect(surfaceOfComputerKind(null)).toBeNull();
  });
});


it("does not instruct use of a selected browser when no surface is mounted", () => {
  expect(surfacePrompt({ computer: null, browser: false }, { canSelect: true })).not.toContain("For online research");
  expect(surfacePrompt({ computer: null, browser: true })).toContain("For online research");
});

describe("cloudPlaceRefusal", () => {
  const engine = (patch: { computerMcp?: boolean }) => ({ name: "Llama", ...patch });

  it("lets every engine with computer tools use the cloud computer, whatever it runs on", () => {
    expect(cloudPlaceRefusal(engine({ computerMcp: true }), "works-on", "Scout")).toBeNull();
    expect(cloudPlaceRefusal(engine({ computerMcp: true }), "routine", "Scout")).toBeNull();
  });

  it("refuses an engine without computer tools as one state, its fix the same whatever the source", () => {
    const refused = cloudPlaceRefusal(engine({ computerMcp: false }), "works-on", "Scout")!;
    expect(refused).toMatchObject({ name: "PlaceUnavailableError", place: "cloud", row: { state: "cc-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" } });
    expect(refused.message).toBe("Llama can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
    for (const source of ["pin", "routine", "room"] as const) {
      expect(cloudPlaceRefusal(engine({}), source, "Scout")?.message).toBe(refused.message);
    }
  });
});

describe("computerToolsRefusal", () => {
  it("refuses a Tool selection without the computer with one action: the setting that changes it", () => {
    const refused = computerToolsRefusal({ deny: ["mcp:computer:*"] }, "works-on", "Scout")!;
    expect(refused).toMatchObject({ name: "PlaceUnavailableError", place: "cloud", row: { state: "cc-tools-off", params: { bot: "Scout" }, source: "works-on" } });
    const line = "What Scout can use doesn't include a computer. Let Scout use the computer from its Computer tab.";
    expect(refused.message).toBe(line);
    for (const source of ["pin", "routine", "room"] as const) {
      expect(computerToolsRefusal({ allow: ["native:*"] }, source, "Scout")?.message).toBe(line);
    }
    expect(computerToolsRefusal({ allow: ["native:*"] }, "auto-pin", "Scout")?.message)
      .toBe("What Scout can use doesn't include a computer. This conversation is back on Auto. Let Scout use the computer from its Computer tab.");
  });

  it("lets every selection that keeps a computer tool through", () => {
    expect(computerToolsRefusal(undefined, "works-on", "Scout")).toBeNull();
    expect(computerToolsRefusal({ allow: ["native:*", "mcp:computer:screenshot"] }, "works-on", "Scout")).toBeNull();
    expect(computerToolsRefusal({ deny: ["mcp:computer:exec"] }, "works-on", "Scout")).toBeNull();
  });
});

describe("placeUnavailable", () => {
  it("words a passing cause's way on by where the place came from, and never says Set Works on to Auto", () => {
    const cause = (source: "works-on" | "pin" | "auto-pin" | "routine" | "room") =>
      placeUnavailable("cloud", { state: "cc-no-start", params: { bot: "Scout" }, source }).message;
    expect(cause("works-on")).toBe("Scout's cloud computer didn't start. Try again.");
    expect(cause("pin")).toBe("Scout's cloud computer didn't start. Clear this conversation's place in the composer to continue.");
    expect(cause("auto-pin")).toBe("Scout's cloud computer didn't start. This conversation is back on Auto. Send your message again.");
    expect(cause("routine")).toBe("Scout's cloud computer didn't start. Change where this routine runs.");
    expect(cause("room")).toBe("Scout's cloud computer didn't start.");
    expect(placeUnavailable("vm", { state: "place-failed", params: { bot: "Scout", cause: "The Local VM is not ready." }, source: "works-on" }))
      .toMatchObject({ name: "PlaceUnavailableError", place: "vm", message: "The Local VM is not ready. Check it in the Computer tab." });
  });

  it("keeps the whole cause: no row cuts it", () => {
    const long = `${"x".repeat(400)}.`;
    expect(placeUnavailable("vm", { state: "place-failed", params: { bot: "Scout", cause: long }, source: "works-on" }).message)
      .toBe(`${long} Check it in the Computer tab.`);
  });
});
