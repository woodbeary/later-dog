// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrialStatus } from "./CloudTrial";

const fixture = vi.hoisted(() => ({
  serve: (_method: string): unknown => ({ state: "none" }),
  calls: [] as string[],
  confirm: true,
  open: vi.fn(async (_url: string) => {}),
}));
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string }) => {
    if (path !== "/api/computers/trial") throw new Error(`unexpected ${path}`);
    const method = init?.method ?? "GET";
    fixture.calls.push(method);
    const answer = fixture.serve(method);
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.open }));

const { CloudTrialRow, trialSubtitle } = await import("./CloudTrial");

const PAGE = `https://trial.example.test/trial?claim=${"a".repeat(64)}`;
const offered: TrialStatus = { state: "offered", minutes: 30, days: 7 };
const pending: TrialStatus = { state: "pending", url: PAGE };
const active = (minutesLeft: number): TrialStatus => ({ state: "active", minutes: 30, minutesLeft, expiresAt: "2026-10-17T12:00:00.000Z" });

let root: Root | null = null;
const flush = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
};
const mount = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(CloudTrialRow)));
  await flush();
};
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label) ?? null;
const click = async (label: string) => {
  flushSync(() => button(label)!.click());
  await flush();
};
const gets = () => fixture.calls.filter((method) => method === "GET").length;
const wait = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fixture.serve = () => ({ state: "none" });
  fixture.calls = [];
  fixture.confirm = true;
  fixture.open.mockClear();
  vi.stubGlobal("confirm", () => fixture.confirm);
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the free trial row", () => {
  it("stays out of the way when there is no trial to offer", async () => {
    await mount();
    expect(text()).toBe("");
    await wait(60_000);
    expect(fixture.calls).toEqual(["GET"]);
  });

  it("starts a trial, opens the check in the browser, and can open it again or cancel it", async () => {
    let started = false;
    fixture.serve = (method) => {
      if (method === "POST") started = true;
      if (method === "DELETE") started = false;
      return started ? pending : offered;
    };
    await mount();
    expect(text()).toBe("Free trial30 free minutes on a cloud computer, to use within 7 daysStart free trial");

    await click("Start free trial");
    expect(fixture.calls).toEqual(["GET", "POST"]);
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith(PAGE);
    expect(text()).toContain("Finish the quick check in your browser to start");

    await click("Open");
    expect(fixture.open).toHaveBeenCalledTimes(2);
    expect(fixture.open).toHaveBeenLastCalledWith(PAGE);

    await click("Cancel");
    expect(fixture.calls).toEqual(["GET", "POST", "DELETE"]);
    expect(button("Start free trial")).not.toBeNull();
    await wait(60_000);
    expect(fixture.calls).toEqual(["GET", "POST", "DELETE"]);
  });

  it("checks every few seconds while the browser check is pending, then every half minute", async () => {
    let answer: TrialStatus | Error = pending;
    fixture.serve = () => answer;
    await mount();
    await wait(2_999);
    expect(gets()).toBe(1);
    answer = new Error("The later.dog cloud computers service could not be reached");
    await wait(1);
    expect(gets()).toBe(2);
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(text()).toContain("Finish the quick check in your browser to start");

    answer = active(12);
    await wait(3_000);
    expect(gets()).toBe(3);
    expect(text()).toBe("Free trial12 minutes leftEnd trial");

    answer = active(1);
    await wait(29_999);
    expect(gets()).toBe(3);
    await wait(1);
    expect(gets()).toBe(4);
    expect(text()).toContain("1 minute left");
  });

  it("ends a trial only once the person agrees, then says it has ended", async () => {
    let ended = false;
    fixture.serve = (method) => {
      if (method === "DELETE") ended = true;
      return ended ? { state: "ended" } : { state: "used_up", minutes: 30, expiresAt: "2026-10-17T12:00:00.000Z" };
    };
    await mount();
    expect(text()).toBe("Free trialAll 30 free minutes are usedEnd trial");

    fixture.confirm = false;
    await click("End trial");
    expect(fixture.calls).toEqual(["GET"]);

    fixture.confirm = true;
    await click("End trial");
    expect(fixture.calls).toEqual(["GET", "DELETE"]);
    expect(text()).toBe("Your free trial has ended.");
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows a refusal in the service's own words and leaves the offer to try again", async () => {
    fixture.serve = (method) => method === "POST" ? new Error("Cloud computers are already set up here") : offered;
    await mount();
    await click("Start free trial");
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Cloud computers are already set up here");
    expect(fixture.open).not.toHaveBeenCalled();
    expect(button("Start free trial")!.disabled).toBe(false);
  });

  it("says why it can't show the trial when the first check fails", async () => {
    fixture.serve = () => new Error("The later.dog cloud computers service could not be reached");
    await mount();
    expect(text()).toBe("The later.dog cloud computers service could not be reached");
  });

  it("stops checking once Settings closes", async () => {
    fixture.serve = () => pending;
    await mount();
    root!.unmount();
    root = null;
    await wait(60_000);
    expect(fixture.calls).toEqual(["GET"]);
  });

  it("reads each state in a few words", () => {
    expect(trialSubtitle(offered)).toBe("30 free minutes on a cloud computer, to use within 7 days");
    expect(trialSubtitle(active(0))).toBe("0 minutes left");
    expect(trialSubtitle(active(1))).toBe("1 minute left");
    expect(trialSubtitle({ state: "none" })).toBe("");
    expect(trialSubtitle({ state: "ended" })).toBe("");
  });
});
