import { describe, expect, it } from "vitest";
import { screenGoals, screenStep, type ScreenGoalMessage } from "./screen-goals.ts";

const ask = (id: string, at: number, text: string): ScreenGoalMessage => ({ id, role: "user", kind: "text", text, at });
const reply = (id: string, at: number, text = "ok"): ScreenGoalMessage => ({ id, role: "bot", kind: "text", text, at });
const act = (id: string, at: number, name: string, input?: unknown, ok = true): ScreenGoalMessage => ({ id, role: "bot", kind: "activity", at, tool: { name, ok, input } });

describe("a step on the dog's computer", () => {
  it("names what the dog did, with the place it opened and the keys it pressed", () => {
    expect(screenStep(act("a", 1, "mcp__computer__screenshot"))).toMatchObject({ action: "look", ok: true });
    expect(screenStep(act("a", 1, "mcp__computer__click", '{"x":10,"y":20}'))).toMatchObject({ action: "click" });
    expect(screenStep(act("a", 1, "mcp__computer__open_url", '{"url":"https://www.example.com/a?b=1"}'))).toMatchObject({ action: "open", detail: "example.com" });
    expect(screenStep(act("a", 1, "mcp__computer__open_url", '{"url":"file:///etc/passwd"}'))).toEqual({ id: "a", at: 1, action: "open", ok: true });
    expect(screenStep(act("a", 1, "mcp__computer__key_press", { keys: ["ctrl", "l"] }))).toMatchObject({ action: "key", detail: "ctrl l" });
    expect(screenStep(act("a", 1, "mcp__computer__scroll"))).toMatchObject({ action: "scroll" });
    expect(screenStep(act("a", 1, "mcp__computer__drag"))).toMatchObject({ action: "drag" });
    expect(screenStep(act("a", 1, "mcp__computer__exec", '{"command":"ls"}'))).toMatchObject({ action: "run" });
    expect(screenStep(act("a", 1, "mcp__browser__browser_navigate", '{"url":"https://later.dog"}'))).toMatchObject({ action: "open", detail: "later.dog" });
    expect(screenStep(act("a", 1, "mcp__computer__click", undefined, false))).toMatchObject({ ok: false });
  });

  it("counts typed characters without keeping what was typed", () => {
    const step = screenStep(act("a", 1, "mcp__computer__type_text", '{"text":"hunter2 é"}'));
    expect(step).toEqual({ id: "a", at: 1, action: "type", detail: "9", ok: true });
    expect(JSON.stringify(step)).not.toContain("hunter2");
    expect(screenStep(act("a", 1, "fill_secure_field", { text: "secret" }))).toEqual({ id: "a", at: 1, action: "fill", ok: true });
  });

  it("leaves out tools that never touch a screen, and messages that aren't steps", () => {
    expect(screenStep(act("a", 1, "Bash"))).toBeNull();
    expect(screenStep(act("a", 1, "mcp__laterdog__remember"))).toBeNull();
    expect(screenStep(reply("a", 1))).toBeNull();
  });
});

describe("the goals a dog worked toward on its computer", () => {
  it("makes each request that led to computer steps a goal, oldest first", () => {
    const goals = screenGoals([
      ask("u1", 1, "What's the weather?"),
      reply("r1", 2, "Sunny."),
      ask("u2", 3, "  Book a table for two at 7  "),
      act("s1", 4, "mcp__computer__open_url", '{"url":"https://example.com"}'),
      act("s2", 5, "mcp__computer__click"),
      reply("r2", 6, "Booked."),
      ask("u3", 7, "Now check my email"),
      act("s3", 8, "mcp__computer__screenshot"),
    ]);
    expect(goals.map((goal) => [goal.id, goal.text, goal.steps.map((step) => step.id), goal.latest])).toEqual([
      ["u2", "Book a table for two at 7", ["s1", "s2"], false],
      ["u3", "Now check my email", ["s3"], true],
    ]);
  });

  it("is not the latest goal once the person has asked something else", () => {
    const goals = screenGoals([ask("u1", 1, "Open the site"), act("s1", 2, "mcp__computer__click"), ask("u2", 3, "thanks")]);
    expect(goals).toHaveLength(1);
    expect(goals[0]!.latest).toBe(false);
  });

  it("orders by time, ignores steps before any request, and keeps the most recent goals", () => {
    expect(screenGoals([act("s0", 0, "mcp__computer__click")])).toEqual([]);
    const shuffled = screenGoals([act("s1", 2, "mcp__computer__click"), ask("u1", 1, "Go")]);
    expect(shuffled.map((goal) => goal.id)).toEqual(["u1"]);
    const many = Array.from({ length: 25 }, (_, index) => [ask(`u${index}`, index * 2, `goal ${index}`), act(`s${index}`, index * 2 + 1, "mcp__computer__click")]).flat();
    const kept = screenGoals(many);
    expect(kept).toHaveLength(20);
    expect(kept[0]!.id).toBe("u5");
    expect(kept.at(-1)!.latest).toBe(true);
  });
});
