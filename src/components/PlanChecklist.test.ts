// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DogPlan } from "./PlanChecklist";

const mount = (element: ReactElement) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
};

const plan = { updatedAt: 1, items: [
  { text: "Fix the login", status: "done" as const },
  { text: "Write the release note", status: "in_progress" as const },
  { text: "Tell the team", status: "pending" as const },
] };

describe("a dog's plan under its working line", () => {
  it("lists every item while the dog works, done checked and the current one marked", () => {
    const host = mount(createElement(DogPlan, { plan, working: true }));
    expect(host.querySelector("[data-dog-plan]")?.getAttribute("data-dog-plan")).toBe("open");
    const rows = [...host.querySelectorAll("li")];
    expect(rows.map((row) => [row.getAttribute("data-plan-status"), row.textContent])).toEqual([
      ["done", "Fix the login"], ["in_progress", "Write the release note"], ["pending", "Tell the team"],
    ]);
    expect(host.querySelector("ul")?.getAttribute("aria-label")).toBe("Plan");
    expect(rows[1]!.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    const slots = rows.map((row) => row.firstElementChild);
    expect(slots.every((slot) => slot?.hasAttribute("data-plan-icon") && slot.getAttribute("class")?.split(" ").includes("w-4") && slot.getAttribute("class")?.includes("shrink-0"))).toBe(true);
    expect(host.querySelector("[data-dog-plan]")?.getAttribute("class")).toContain("ml-11");
  });

  it("folds to how many are done when the dog is idle", () => {
    const host = mount(createElement(DogPlan, { plan, working: false }));
    expect(host.querySelector("[data-dog-plan]")?.getAttribute("data-dog-plan")).toBe("folded");
    const line = host.querySelector("button")!;
    expect(line.textContent).toBe("1 of 3 done");
    expect(line.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(line.lastElementChild?.getAttribute("class")).toContain("chevron-right");
    expect(line.getAttribute("class")).toContain("text-[12px]");
    expect(line.getAttribute("class")).toContain("text-ink-secondary");
    expect(host.querySelector("[data-dog-plan]")?.getAttribute("class")).not.toContain("ml-11");
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll("li")).toHaveLength(0);
  });

  it("shows nothing without a plan", () => {
    expect(renderToStaticMarkup(createElement(DogPlan, { plan: undefined, working: true }))).toBe("");
    expect(renderToStaticMarkup(createElement(DogPlan, { plan: { items: [], updatedAt: 1 }, working: false }))).toBe("");
  });
});
