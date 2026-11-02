import { toScreen, type Point, type Size } from "./computer-use-frame.ts";

export const TOOLSET_NAME = "computer";
export const TOOLSET_MEMBERS = [
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag",
  "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position", "scroll", "type", "key", "hold_key", "wait",
] as const;
export type ToolsetMember = typeof TOOLSET_MEMBERS[number];
export const WITHHELD_MEMBERS: readonly ToolsetMember[] = ["zoom"];
export const MAX_TYPED_CHARS = 10_000;
export const MAX_HOLD_SECONDS = 300;

export type Button = "left" | "middle" | "right";
export type ScrollDirection = "up" | "down" | "left" | "right";

export type ComputerAction =
  | { kind: "screenshot" }
  | { kind: "click"; button: Button; count: 1 | 2 | 3; at?: Point; modifiers: string[] }
  | { kind: "drag"; from: Point; to: Point; modifiers: string[] }
  | { kind: "move"; to: Point }
  | { kind: "mouse_down" }
  | { kind: "mouse_up" }
  | { kind: "cursor_position" }
  | { kind: "scroll"; direction: ScrollDirection; amount: number; at?: Point; modifiers: string[] }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string; repeat: number }
  | { kind: "hold_key"; keys: string; seconds: number }
  | { kind: "wait"; seconds: number };

export type ParsedAction = { action: ComputerAction } | { problem: string };

const MODIFIER = /^(shift|ctrl|alt|super)$/;
const KEY_COMBO = /^[A-Za-z0-9_]{1,40}(\+[A-Za-z0-9_]{1,40}){0,4}$/;
const CLICKS: Record<string, { button: Button; count: 1 | 2 | 3 }> = {
  left_click: { button: "left", count: 1 }, right_click: { button: "right", count: 1 }, middle_click: { button: "middle", count: 1 },
  double_click: { button: "left", count: 2 }, triple_click: { button: "left", count: 3 },
};

function point(raw: unknown, frame: Size): Point | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [x, y] = raw;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return [Math.round(x), Math.round(y)];
}

function modifiers(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw !== "string") return null;
  const parts = raw.toLowerCase().split("+");
  return parts.every((part) => MODIFIER.test(part)) ? [...new Set(parts)] : null;
}

function seconds(raw: unknown, max: number): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : null;
}

export function isToolsetMember(name: string): name is ToolsetMember {
  return (TOOLSET_MEMBERS as readonly string[]).includes(name);
}

export function parseAction(name: string, input: unknown, frame: Size): ParsedAction {
  if (!isToolsetMember(name)) return { problem: `${name} is not a computer tool.` };
  if (WITHHELD_MEMBERS.includes(name)) return { problem: `${name} is switched off for this desktop. Take a screenshot instead.` };
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const outside = `Coordinates must be [x, y] inside the ${frame.width}x${frame.height} screenshot.`;
  const click = CLICKS[name];
  if (click) {
    const mods = modifiers(args.text);
    if (!mods) return { problem: "text may only hold shift, ctrl, alt or super, joined with +." };
    if (args.coordinate === undefined) return { action: { kind: "click", ...click, modifiers: mods } };
    const at = point(args.coordinate, frame);
    return at ? { action: { kind: "click", ...click, at, modifiers: mods } } : { problem: outside };
  }
  switch (name) {
    case "screenshot": return { action: { kind: "screenshot" } };
    case "cursor_position": return { action: { kind: "cursor_position" } };
    case "left_mouse_down": return { action: { kind: "mouse_down" } };
    case "left_mouse_up": return { action: { kind: "mouse_up" } };
    case "mouse_move": {
      const to = point(args.coordinate, frame);
      return to ? { action: { kind: "move", to } } : { problem: outside };
    }
    case "left_click_drag": {
      const from = point(args.start_coordinate, frame);
      const to = point(args.coordinate, frame);
      const mods = modifiers(args.text);
      if (!from || !to) return { problem: outside };
      return mods ? { action: { kind: "drag", from, to, modifiers: mods } } : { problem: "text may only hold shift, ctrl, alt or super, joined with +." };
    }
    case "scroll": {
      const direction = args.scroll_direction;
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") return { problem: "scroll_direction must be up, down, left or right." };
      const amount = args.scroll_amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 100) return { problem: "scroll_amount must be a whole number from 1 to 100." };
      const mods = modifiers(args.text);
      if (!mods) return { problem: "text may only hold shift, ctrl, alt or super, joined with +." };
      if (args.coordinate === undefined) return { action: { kind: "scroll", direction, amount, modifiers: mods } };
      const at = point(args.coordinate, frame);
      return at ? { action: { kind: "scroll", direction, amount, at, modifiers: mods } } : { problem: outside };
    }
    case "type": {
      if (typeof args.text !== "string" || !args.text) return { problem: "type needs text." };
      if (args.text.length > MAX_TYPED_CHARS || args.text.includes("\0")) return { problem: `type takes at most ${MAX_TYPED_CHARS} characters and no NUL.` };
      return { action: { kind: "type", text: args.text } };
    }
    case "key": {
      if (typeof args.text !== "string" || !KEY_COMBO.test(args.text)) return { problem: "key needs one key or a +-joined combination, such as Return or ctrl+s." };
      const repeat = args.repeat ?? 1;
      if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) return { problem: "repeat must be a whole number from 1 to 100." };
      return { action: { kind: "key", keys: args.text, repeat } };
    }
    case "hold_key": {
      if (typeof args.text !== "string" || !KEY_COMBO.test(args.text)) return { problem: "hold_key needs one key or a +-joined combination." };
      const held = seconds(args.duration, MAX_HOLD_SECONDS);
      return held === null ? { problem: `duration must be 0 to ${MAX_HOLD_SECONDS} seconds.` } : { action: { kind: "hold_key", keys: args.text, seconds: held } };
    }
    case "wait": {
      const waited = seconds(args.duration, MAX_HOLD_SECONDS);
      return waited === null ? { problem: `duration must be 0 to ${MAX_HOLD_SECONDS} seconds.` } : { action: { kind: "wait", seconds: waited } };
    }
    default: return { problem: `${name} is not available on this desktop.` };
  }
}

export function onScreen(action: ComputerAction, frame: Size, screen: Size): ComputerAction {
  const map = (at: Point) => toScreen(at, frame, screen);
  switch (action.kind) {
    case "click": return action.at ? { ...action, at: map(action.at) } : action;
    case "scroll": return action.at ? { ...action, at: map(action.at) } : action;
    case "drag": return { ...action, from: map(action.from), to: map(action.to) };
    case "move": return { ...action, to: map(action.to) };
    default: return action;
  }
}

const BUTTONS: Record<Button, number> = { left: 1, middle: 2, right: 3 };
const WHEEL: Record<ScrollDirection, number> = { up: 4, down: 5, left: 6, right: 7 };

const moveTo = (at: Point | undefined) => (at ? ["mousemove", "--sync", String(at[0]), String(at[1])] : []);
const press = (mods: string[]) => mods.flatMap((mod) => ["keydown", mod]);
const release = (mods: string[]) => [...mods].reverse().flatMap((mod) => ["keyup", mod]);

export function xdotoolCommand(action: Exclude<ComputerAction, { kind: "screenshot" | "wait" }>): string {
  switch (action.kind) {
    case "click":
      return ["xdotool", ...moveTo(action.at), ...press(action.modifiers), "click", "--repeat", String(action.count), "--delay", "100", String(BUTTONS[action.button]), ...release(action.modifiers)].join(" ");
    case "drag":
      return ["xdotool", ...moveTo(action.from), ...press(action.modifiers), "mousedown", "1", ...moveTo(action.to), "mouseup", "1", ...release(action.modifiers)].join(" ");
    case "move":
      return ["xdotool", ...moveTo(action.to)].join(" ");
    case "mouse_down":
      return "xdotool mousedown 1";
    case "mouse_up":
      return "xdotool mouseup 1";
    case "cursor_position":
      return "xdotool getmouselocation --shell";
    case "scroll":
      return ["xdotool", ...moveTo(action.at), ...press(action.modifiers), "click", "--repeat", String(action.amount), "--delay", "50", String(WHEEL[action.direction]), ...release(action.modifiers)].join(" ");
    case "type":
      return `printf %s '${Buffer.from(action.text, "utf8").toString("base64")}' | base64 -d | xdotool type --clearmodifiers --delay 12 --file -`;
    case "key":
      return ["xdotool", "key", "--clearmodifiers", "--repeat", String(action.repeat), "--delay", "50", action.keys].join(" ");
    case "hold_key":
      return ["xdotool", "keydown", action.keys, "sleep", String(action.seconds), "keyup", action.keys].join(" ");
  }
}

export function cursorFromXdotool(stdout: string): Point | null {
  const x = /^X=(\d+)$/m.exec(stdout)?.[1];
  const y = /^Y=(\d+)$/m.exec(stdout)?.[1];
  return x === undefined || y === undefined ? null : [Number(x), Number(y)];
}

export function describeAction(name: string, input: unknown): Record<string, unknown> {
  const args = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  if (name === "type" && typeof args.text === "string") args.text = `${args.text.length} characters`;
  return { name, ...args };
}
