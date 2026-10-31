// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { UsageGitHub, type GitHubActivity } from "./UsageGitHub";

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";

async function show(activity: GitHubActivity | Error) {
  const load = async () => { if (activity instanceof Error) throw activity; return activity; };
  await act(async () => root.render(createElement(UsageGitHub, { load })));
  await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("commits and PRs on the Usage page", () => {
  it("shows today's commits and PRs, the 30-day totals and a thin chart for each", async () => {
    await show({ state: "ready", login: "dogfan", today: "2026-10-30", days: [
      { day: "2026-10-29", commits: 7, prs: 2 },
      { day: "2026-10-30", commits: 12, prs: 3 },
    ] });
    expect(host.querySelector("[data-usage-github]")!.getAttribute("data-usage-github")).toBe("ready");
    expect(text()).toContain("Commits today12");
    expect(text()).toContain("PRs today3");
    expect(text()).toContain("19 commits · 5 PRs");
    expect([...host.querySelectorAll("[data-github-chart]")].map((chart) => chart.getAttribute("data-github-chart"))).toEqual(["commits", "prs"]);
  });

  it("says in one quiet line that GitHub needs a sign-in, with no chart and no error", async () => {
    await show({ state: "signedOut" });
    expect(host.querySelector("[data-usage-github]")!.getAttribute("data-usage-github")).toBe("signedOut");
    expect(text()).toContain("Sign in to GitHub where later.dog runs to see commits and PRs a day.");
    expect(host.querySelector("[data-github-chart]")).toBeNull();
    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  it("says it is checking while GitHub is still answering", async () => {
    await act(async () => root.render(createElement(UsageGitHub, { load: () => new Promise<GitHubActivity>(() => {}) })));
    expect(host.querySelector("[data-usage-github]")!.getAttribute("data-usage-github")).toBe("checking");
    expect(text()).toContain("Checking");
  });

  it("stays quiet when GitHub does not answer", async () => {
    await show(new Error("network down"));
    expect(text()).toContain("GitHub didn't answer just now.");
    expect(text()).not.toContain("network down");
  });
});
