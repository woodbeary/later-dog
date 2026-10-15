// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoReviewOn, autoReviewSwitchShown, offLeashActsWithoutAsking } from "@/lib/auto-review";

const fixture = vi.hoisted(() => ({
  config: { cloudHome: true, features: {} } as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const { AutoReviewRow, STILL_ASKS_FIRST } = await import("./AutoReviewSettings");

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(AutoReviewRow)));
  return { host, root, toggle: () => host.querySelector<HTMLButtonElement>('[role="switch"]')! };
}

afterEach(() => {
  vi.clearAllMocks();
  fixture.config = { cloudHome: true, features: {} };
  document.body.innerHTML = "";
});

describe("Auto-review", () => {
  it("is on unless the account turned it off, and only a Cloud home shows it", () => {
    expect(autoReviewOn({})).toBe(true);
    expect(autoReviewOn({ features: { autoReview: false } })).toBe(false);
    expect(autoReviewSwitchShown({})).toBe(false);
    expect(offLeashActsWithoutAsking({ features: { autoReview: false } })).toBe(false);
    expect(offLeashActsWithoutAsking({ cloudHome: true, features: { autoReview: false } })).toBe(true);
    expect(offLeashActsWithoutAsking({ cloudHome: true, features: {} })).toBe(false);
  });

  it("turns off for the whole account and hands the new settings to the app", async () => {
    const saved = { cloudHome: true, features: { autoReview: false } };
    fixture.api.mockResolvedValueOnce(saved);
    const { root, toggle } = mount();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { autoReview: false } }) });
    root.unmount();
  });

  it("says, while off, what still asks first", () => {
    fixture.config = { cloudHome: true, features: { autoReview: false } };
    const { host, root, toggle } = mount();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Off-leash dogs act without asking you first.");
    const list = [...host.querySelectorAll("[data-auto-review-still-asks] li")].map((item) => item.textContent);
    expect(list).toHaveLength(STILL_ASKS_FIRST.length);
    expect(list).toEqual([
      "Dogs you set to Heel",
      "Questions a dog asks you",
      "Sending for you: email, messages, posts, invites, payments",
      "A command that needs to leave its sandbox",
      "Using your Mac, unless you set your Mac to Always allow",
      "A dog changing another dog, a pack or your team",
      "Work an app on your Mac starts or joins, like Claude Code or Codex",
    ]);
    root.unmount();
  });

  it("says so when the save fails and leaves the setting alone", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    const { host, root, toggle } = mount();
    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not save. Try again."));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    root.unmount();
  });
});
