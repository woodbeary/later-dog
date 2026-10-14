import { describe, expect, it } from "vitest";
import { toolDecisionFrom } from "../src/decide";
import { SCREEN_CHECK_MODEL, actionTimeoutMs, SCREEN_STATES, actionCommand, actionSummary, checkRequest, readScreenCheck } from "../src/mcp-screen";

const frame = `data:image/jpeg;base64,${btoa("\xff\xd8\xff\xe0pixels")}`;

describe("the screen check's question", () => {
  it("is a question the decision service accepts, with or without an expectation", () => {
    for (const expect_ of [undefined, "The menu is open."]) {
      const request = checkRequest("click at (1, 2)", expect_, frame, frame);
      const parsed = toolDecisionFrom(request);
      expect(parsed, String(expect_)).toMatchObject({ ok: true, decision: { kind: "toolQuestions", model: SCREEN_CHECK_MODEL } });
      expect(Object.keys(request.questions)).toEqual(expect_ === undefined ? ["screen", "changed"] : ["screen", "changed", "matches_expectation"]);
    }
  });

  it("offers every screen state and no other", () => {
    const { screen } = checkRequest("x", undefined, frame, frame).questions;
    expect(Object.keys(screen.criteria)).toEqual([...SCREEN_STATES]);
    expect(SCREEN_STATES).toEqual(["ready", "loading", "login", "two_factor", "captcha", "error", "dialog"]);
  });
});

describe("reading Clef's answer", () => {
  it("reads the screen, how sure it is, and whether it changed", () => {
    const answer = {
      answers: {
        screen: { type: "choice", choice: "login", probabilities: { login: 0.8123, ready: 0.1877 } },
        changed: { type: "noul", noul: 0.456 },
        matches_expectation: { type: "noul", noul: 1 },
      },
    };
    expect(readScreenCheck(answer, 2)).toEqual({ screen: "login", confidence: 0.81, changed: 0.46, matches_expectation: 1, looks: 2 });
  });

  it("leaves out numbers that are missing or not probabilities", () => {
    const answer = { answers: { screen: { choice: "ready", probabilities: { ready: 7 } }, changed: { noul: "high" } } };
    expect(readScreenCheck(answer, 1)).toEqual({ screen: "ready", looks: 1 });
  });

  it("returns nothing for an answer without a known screen", () => {
    for (const odd of [null, "x", {}, { answers: null }, { answers: { screen: {} } }, { answers: { screen: { choice: "weird" } } }, { answers: { screen: { choice: 4 } } }]) {
      expect(readScreenCheck(odd, 1), JSON.stringify(odd)).toBeNull();
    }
  });
});

describe("actions as xdotool commands", () => {
  it("quotes everything a person or model chooses", () => {
    expect(actionCommand({ action: "type", text: "a'b\"c`d$e\nf" })).toEqual({ ok: true, command: `xdotool type --delay 12 -- 'a'\\''b"c\`d$e\nf'` });
    expect(actionCommand({ action: "key", key: "ctrl+a  Delete" })).toEqual({ ok: true, command: "xdotool key -- 'ctrl+a' 'Delete'" });
  });

  it("names what is missing", () => {
    expect(actionCommand({ action: "click", x: 1 })).toEqual({ ok: false, message: "click needs x and y." });
    expect(actionCommand({ action: "double_click", y: 1 })).toEqual({ ok: false, message: "double_click needs x and y." });
    expect(actionCommand({ action: "type" })).toEqual({ ok: false, message: "type needs text." });
    expect(actionCommand({ action: "key", key: " " })).toEqual({ ok: false, message: "key needs a key name such as Return or ctrl+l." });
    expect(actionCommand({ action: "scroll", x: 1 })).toEqual({ ok: false, message: "scroll needs both x and y, or neither." });
    expect(actionCommand({ action: "drag", x: 1, y: 1, to_x: 2 })).toEqual({ ok: false, message: "drag needs x, y, to_x and to_y." });
    expect(actionCommand({ action: "wiggle" })).toEqual({ ok: false, message: "action must be click, double_click, type, key, scroll or drag." });
  });

  it("refuses a NUL in typed text and scales the typing timeout", () => {
    expect(actionCommand({ action: "type", text: "a\u0000b" })).toEqual({ ok: false, message: "type text cannot contain a NUL character." });
    expect(actionTimeoutMs({ action: "type", text: "x".repeat(100) })).toBe(6200);
    expect(actionTimeoutMs({ action: "type", text: "x".repeat(1000) })).toBe(17_000);
    expect(actionTimeoutMs({ action: "click", x: 1, y: 1 })).toBe(20_000);
  });

  it("uses the wheel buttons for each direction", () => {
    const wheel = (direction: string) => (actionCommand({ action: "scroll", direction }) as { command: string }).command.split(" ").at(-1);
    expect([wheel("up"), wheel("down"), wheel("left"), wheel("right")]).toEqual(["4", "5", "6", "7"]);
  });

  it("describes an action without the text that was typed", () => {
    expect(actionSummary({ action: "type", text: "hunter2" })).toBe("typed 7 characters");
    expect(actionSummary({ action: "click", x: 1, y: 2, button: "right" })).toBe("right click at (1, 2)");
    expect(actionSummary({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 })).toBe("dragged from (1, 2) to (3, 4)");
    expect(actionSummary({ action: "scroll", direction: "left" })).toBe("scrolled left");
    expect(actionSummary({ action: "key", key: "Return" })).toBe("pressed Return");
  });
});
