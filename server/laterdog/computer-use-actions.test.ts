import { describe, expect, it } from "vitest";
import { cursorFromXdotool, describeAction, onScreen, parseAction, TOOLSET_MEMBERS, xdotoolCommand, type ComputerAction } from "./computer-use-actions.ts";

const frame = { width: 1280, height: 800 };
const action = (name: string, input: Record<string, unknown> = {}): ComputerAction => {
  const parsed = parseAction(name, input, frame);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return parsed.action;
};
const problem = (name: string, input: Record<string, unknown> = {}) => {
  const parsed = parseAction(name, input, frame);
  return "problem" in parsed ? parsed.problem : null;
};

describe("reading Claude's computer actions", () => {
  it("knows all seventeen members of the toolset", () => {
    expect(TOOLSET_MEMBERS).toHaveLength(17);
  });

  it("reads clicks, with or without a point and modifier keys", () => {
    expect(action("left_click", { coordinate: [512, 742] })).toEqual({ kind: "click", button: "left", count: 1, at: [512, 742], modifiers: [] });
    expect(action("triple_click", { coordinate: [1, 2], text: "ctrl+shift" })).toEqual({ kind: "click", button: "left", count: 3, at: [1, 2], modifiers: ["ctrl", "shift"] });
    expect(action("right_click")).toEqual({ kind: "click", button: "right", count: 1, modifiers: [] });
    expect(action("double_click", { coordinate: [10.4, 20.6] })).toMatchObject({ count: 2, at: [10, 21] });
  });

  it("reads drags, scrolls, keys, typing and waits", () => {
    expect(action("left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] })).toEqual({ kind: "drag", from: [1, 2], to: [3, 4], modifiers: [] });
    expect(action("scroll", { scroll_direction: "down", scroll_amount: 5, coordinate: [640, 400] })).toEqual({ kind: "scroll", direction: "down", amount: 5, at: [640, 400], modifiers: [] });
    expect(action("key", { text: "ctrl+s" })).toEqual({ kind: "key", keys: "ctrl+s", repeat: 1 });
    expect(action("key", { text: "Return", repeat: 3 })).toEqual({ kind: "key", keys: "Return", repeat: 3 });
    expect(action("type", { text: "Jane O'Neil; rm -rf ~" })).toEqual({ kind: "type", text: "Jane O'Neil; rm -rf ~" });
    expect(action("hold_key", { text: "shift", duration: 2 })).toEqual({ kind: "hold_key", keys: "shift", seconds: 2 });
    expect(action("wait", { duration: 1.5 })).toEqual({ kind: "wait", seconds: 1.5 });
    expect(action("mouse_move", { coordinate: [5, 6] })).toEqual({ kind: "move", to: [5, 6] });
    expect(action("cursor_position")).toEqual({ kind: "cursor_position" });
    expect(action("left_mouse_down")).toEqual({ kind: "mouse_down" });
  });

  it("answers a wrong call in plain words instead of acting", () => {
    expect(problem("left_click", { coordinate: [1281, 10] })).toBe("Coordinates must be [x, y] inside the 1280x800 screenshot.");
    expect(problem("left_click", { coordinate: [-1, 10] })).toMatch(/inside the 1280x800/);
    expect(problem("left_click", { coordinate: "10,10" })).toMatch(/inside the 1280x800/);
    expect(problem("left_click", { text: "hyper" })).toMatch(/shift, ctrl, alt or super/);
    expect(problem("scroll", { scroll_direction: "sideways", scroll_amount: 1 })).toMatch(/scroll_direction/);
    expect(problem("scroll", { scroll_direction: "up", scroll_amount: 0 })).toMatch(/scroll_amount/);
    expect(problem("key", { text: "ctrl+s; reboot" })).toMatch(/one key or a \+-joined combination/);
    expect(problem("type", { text: "" })).toBe("type needs text.");
    expect(problem("wait", { duration: 301 })).toMatch(/0 to 300 seconds/);
    expect(problem("zoom", { region: [0, 0, 10, 10] })).toBe("zoom is switched off for this desktop. Take a screenshot instead.");
    expect(problem("open_terminal")).toBe("open_terminal is not a computer tool.");
  });
});

describe("acting on later.dog's cloud desktop", () => {
  it("maps points from the screenshot to the screen before acting", () => {
    const screen = { width: 2560, height: 1600 };
    const small = { width: 1728, height: 1080 };
    const parsed = parseAction("left_click_drag", { start_coordinate: [864, 540], coordinate: [1728, 1080] }, small);
    if ("problem" in parsed) throw new Error(parsed.problem);
    expect(onScreen(parsed.action, small, screen)).toEqual({ kind: "drag", from: [1280, 800], to: [2559, 1599], modifiers: [] });
  });

  it("turns each action into one xdotool command built only from checked values", () => {
    expect(xdotoolCommand({ kind: "click", button: "left", count: 2, at: [10, 20], modifiers: ["ctrl"] }))
      .toBe("xdotool mousemove --sync 10 20 keydown ctrl click --repeat 2 --delay 100 1 keyup ctrl");
    expect(xdotoolCommand({ kind: "click", button: "right", count: 1, modifiers: [] })).toBe("xdotool click --repeat 1 --delay 100 3");
    expect(xdotoolCommand({ kind: "drag", from: [1, 2], to: [3, 4], modifiers: [] })).toBe("xdotool mousemove --sync 1 2 mousedown 1 mousemove --sync 3 4 mouseup 1");
    expect(xdotoolCommand({ kind: "scroll", direction: "down", amount: 3, at: [5, 6], modifiers: ["shift"] }))
      .toBe("xdotool mousemove --sync 5 6 keydown shift click --repeat 3 --delay 50 5 keyup shift");
    expect(xdotoolCommand({ kind: "key", keys: "ctrl+s", repeat: 1 })).toBe("xdotool key --clearmodifiers --repeat 1 --delay 50 ctrl+s");
    expect(xdotoolCommand({ kind: "hold_key", keys: "shift", seconds: 2 })).toBe("xdotool keydown shift sleep 2 keyup shift");
    expect(xdotoolCommand({ kind: "cursor_position" })).toBe("xdotool getmouselocation --shell");
  });

  it("types text through base64 so no character reaches the shell", () => {
    const text = "Jane O'Neil; $(reboot) `id` \"quoted\" ñ 日本";
    const command = xdotoolCommand({ kind: "type", text });
    expect(command).toBe(`printf %s '${Buffer.from(text).toString("base64")}' | base64 -d | xdotool type --clearmodifiers --delay 12 --file -`);
    expect(command).not.toContain("Neil");
  });

  it("reads the pointer from xdotool and keeps typed text out of the step log", () => {
    expect(cursorFromXdotool("X=12\nY=34\nSCREEN=0\nWINDOW=1\n")).toEqual([12, 34]);
    expect(cursorFromXdotool("nothing")).toBeNull();
    expect(describeAction("type", { text: "hunter2" })).toEqual({ name: "type", text: "7 characters" });
    expect(describeAction("left_click", { coordinate: [1, 2] })).toEqual({ name: "left_click", coordinate: [1, 2] });
  });
});
