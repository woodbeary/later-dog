import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Puppies, puppyRows, puppyState } from "./Puppies";
import type { Helper } from "../../shared/helpers";

const helper = (id: string): Helper => ({ id, kind: "agent", label: `Helper ${id}`, state: "running", background: true, startedAt: 0 });

it("shows at most five puppies with names and overflow", () => {
  const markup = renderToStaticMarkup(createElement(Puppies, { helpers: Array.from({ length: 7 }, (_, index) => helper(String(index))), color: "green" }));
  expect(markup).toContain('aria-label="7 helpers"');
  expect(markup).toContain("Helper 0 · Working");
  expect(markup).toContain("+2");
  expect(markup).not.toContain("Helper 5");
  expect(puppyState).toEqual({ running: "working", done: "happy", failed: "sad", stopped: "sleeping" });
});

it("shows each workflow member as a puppy with its own phase and state", () => {
  const rows = puppyRows([{ ...helper("flow"), kind: "workflow", members: [{ id: "a", label: "Drafter", phase: "Draft", state: "done" }, { id: "b", label: "Checker", phase: "Check", state: "running" }] }]);
  expect(rows).toEqual([expect.objectContaining({ id: "flow:a", state: "done", phase: "Draft" }), expect.objectContaining({ id: "flow:b", state: "running", phase: "Check" })]);
});
