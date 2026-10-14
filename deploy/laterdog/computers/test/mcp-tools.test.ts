import { describe, expect, it } from "vitest";
import { DECIDE_MODELS } from "../src/decide";
import { SIZES } from "../src/inputs";
import { COMPUTER_ID_PATTERN, COMPUTER_SIZES, DECIDE_TOOL_MODELS, TOOLS, argumentProblem, schemaProblem, toolNamed } from "../src/mcp-tools";
import { COMPUTER_ID } from "../src/ids";

describe("the tool definitions", () => {
  it("name each tool once, in a stable order", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(9);
    expect(toolNamed("decide")).toBe(TOOLS[8]);
    expect(toolNamed("constructor")).toBeUndefined();
    expect(toolNamed(5)).toBeUndefined();
  });

  it("agree with the service about ids, sizes and models", () => {
    expect(COMPUTER_ID_PATTERN).toBe(COMPUTER_ID.source);
    expect([...COMPUTER_SIZES]).toEqual(Object.keys(SIZES));
    for (const model of DECIDE_TOOL_MODELS) expect(Object.keys(DECIDE_MODELS)).toContain(model);
  });

  it("describe computers that sleep and the decision model in plain words", () => {
    const text = (name: string) => toolNamed(name)!.description;
    expect(text("computer_wake")).toContain("30 seconds");
    expect(text("computer_action")).toContain("up to 3 times");
    expect(text("computer_action")).toContain("is a guess");
    expect(text("decide")).toContain("active later.dog Cloud plan");
    expect(text("computer_action")).toContain("screen checks");
    expect(text("computer_viewer_link")).toContain("expires");
  });

  it("mark which tools only read", () => {
    const readOnly = TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name);
    expect(readOnly).toEqual(["computer_list", "computer_screenshot", "decide"]);
    for (const name of ["computer_action", "computer_exec"]) expect(toolNamed(name)!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
  });
});

describe("argument checking", () => {
  const exec = toolNamed("computer_exec")!;
  const id = "cmp_abcdefghij23";

  it("accepts good arguments", () => {
    expect(argumentProblem(exec, { computer_id: id, command: "ls", timeout_ms: 1000, cwd: "/tmp" })).toBeNull();
    expect(argumentProblem(toolNamed("computer_list")!, {})).toBeNull();
  });

  it("refuses the wrong type, range, length and shape", () => {
    expect(argumentProblem(exec, null)).toBe("The arguments must be a JSON object.");
    expect(argumentProblem(exec, [])).toBe("The arguments must be a JSON object.");
    expect(argumentProblem(exec, { computer_id: 5, command: "ls" })).toBe('"computer_id" must be a string.');
    expect(argumentProblem(exec, { computer_id: id, command: 5 })).toBe('"command" must be a string.');
    expect(argumentProblem(exec, { computer_id: id, command: "x".repeat(100_001) })).toBe('"command" must be at most 100000 characters.');
    expect(argumentProblem(exec, { computer_id: id, command: "ls", timeout_ms: 700_000 })).toBe('"timeout_ms" must be at most 600000.');
    expect(argumentProblem(exec, { computer_id: id, command: "ls", timeout_ms: "5s" })).toBe('"timeout_ms" must be a whole number.');
    expect(argumentProblem(exec, { computer_id: id, command: "ls", timeout_ms: 2.5 })).toBe('"timeout_ms" must be a whole number.');
    expect(argumentProblem(exec, { computer_id: id, command: "ls", env: { A: "b" } })).toBe('"env" is not an argument this tool takes.');
  });

  it("does not let a prototype name pass for an argument", () => {
    const hostile = JSON.parse('{"computer_id":"cmp_abcdefghij23","command":"ls","__proto__":{"x":1}}');
    expect(argumentProblem(exec, hostile)).toBe('"__proto__" is not an argument this tool takes.');
    expect(schemaProblem({ type: "object", required: ["constructor"] }, {})).toBe('"constructor" is required.');
  });

  it("checks decide's nested questions and names the path", () => {
    const decide = toolNamed("decide")!;
    const ok = { state: null, questions: { q: { type: "score", instructions: "How bad?", criteria: ["a", "b"] } } };
    expect(argumentProblem(decide, ok)).toBeNull();
    expect(argumentProblem(decide, { ...ok, questions: { q: { type: "score", instructions: "x", criteria: ["a"] } } })).toBe('"questions.q.criteria" needs at least 2 items.');
    expect(argumentProblem(decide, { ...ok, questions: { q: { type: "noul", instructions: "x", criteria: { maybe: "y" } } } })).toBe('"questions.q.criteria.maybe" is not an argument this tool takes.');
    expect(argumentProblem(decide, { ...ok, questions: { q: { type: "noul" } } })).toBe('"questions.q.instructions" is required.');
    expect(argumentProblem(decide, { ...ok, questions: { q: "yes or no?" } })).toBe('"questions.q" is not in a supported shape.');
    expect(argumentProblem(decide, { ...ok, images: [`data:image/png;base64,${"A".repeat(190_000)}`] })).toBe('"images[0]" must be at most 190000 characters.');
    expect(argumentProblem(decide, { ...ok, images: Array.from({ length: 5 }, () => "data:image/png;base64,AAAA") })).toBe('"images" may have at most 4 items.');
  });
});
