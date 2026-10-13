// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { backAt, rechargeProgress, RechargeLine, RestCharge, restSummary, SleepingDog, usageLeft } from "./AccountCharge";

const NOW = Date.UTC(2026, 9, 9, 12);
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const mount = (element: ReactElement) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
};

describe("how far a resting account has recharged", () => {
  it("runs from when it ran out to when it is back, and stays between empty and full", () => {
    expect(rechargeProgress({ since: at(-HOUR), until: at(HOUR) }, NOW)).toBe(0.5);
    expect(rechargeProgress({ since: at(-HOUR), until: at(3 * HOUR) }, NOW)).toBe(0.25);
    expect(rechargeProgress({ since: at(HOUR), until: at(2 * HOUR) }, NOW)).toBe(0);
    expect(rechargeProgress({ since: at(-2 * HOUR), until: at(-HOUR) }, NOW)).toBe(1);
  });

  it("does not guess without a start, or with a start that is not before the end", () => {
    expect(rechargeProgress({ until: at(HOUR) }, NOW)).toBeNull();
    expect(rechargeProgress({ since: at(HOUR), until: at(HOUR) }, NOW)).toBeNull();
    expect(rechargeProgress({ since: "soon", until: at(HOUR) }, NOW)).toBeNull();
    expect(rechargeProgress({ since: at(-HOUR), until: "later" }, NOW)).toBeNull();
  });
});

describe("what an account has left", () => {
  it("is whatever it has not used, in whole percent, never below empty or above full", () => {
    expect(usageLeft(62)).toBe(38);
    expect(usageLeft(0)).toBe(100);
    expect(usageLeft(99.6)).toBe(0);
    expect(usageLeft(130)).toBe(0);
    expect(usageLeft(-5)).toBe(100);
  });
});

describe("when a resting account is back", () => {
  it("names the reset time and how long until it, and only roughly when the reset is estimated", () => {
    const rest = { until: at(HOUR + 15 * 60_000) };
    expect(backAt(rest, NOW)).toMatch(/^Back at (\w{3} \d{1,2}, )?\d{1,2}:\d{2}/);
    expect(restSummary(rest, NOW)).toMatch(/^Back at [^·]+ · in 1h 15m$/);
    const rough = { ...rest, estimated: true };
    expect(backAt(rough, NOW)).toMatch(/^Back around (\w{3} \d{1,2}, )?\d{1,2}:\d{2}/);
    expect(restSummary(rough, NOW)).toBe(backAt(rough, NOW));
  });

  it("gives the day when the account is back after today", () => {
    expect(backAt({ until: at(3 * 24 * HOUR) }, NOW)).toMatch(/^Back at \w{3} \d{1,2}, \d{1,2}:\d{2}/);
  });
});

describe("the recharge line", () => {
  it("fills as far as the account has recharged and says so to a screen reader", () => {
    const line = mount(createElement(RechargeLine, { progress: 0.42 })).firstElementChild!;
    expect(line.getAttribute("role")).toBe("progressbar");
    expect(line.getAttribute("aria-label")).toBe("Recharging");
    expect(line.getAttribute("aria-valuenow")).toBe("42");
    expect(line.getAttribute("aria-valuetext")).toBe("42% recharged");
    expect(line.getAttribute("data-recharge")).toBe("42");
    expect(line.querySelector<HTMLElement>(".recharge-fill")!.style.width).toBe("42%");
  });

  it("shows a faint full line with no reading when it cannot tell how far along it is", () => {
    const line = mount(createElement(RechargeLine, { progress: null })).firstElementChild!;
    expect(line.getAttribute("data-recharge")).toBe("unknown");
    expect(line.hasAttribute("aria-valuenow")).toBe(false);
    expect(line.hasAttribute("aria-valuetext")).toBe(false);
    const fill = line.querySelector<HTMLElement>(".recharge-fill")!;
    expect(fill.className).toContain("opacity-40");
    expect(fill.style.width).toBe("100%");
  });
});

describe("the sleeping dog", () => {
  it("is decoration only: hidden from screen readers, with its z's drawn rather than written", () => {
    const dog = mount(createElement(SleepingDog, { size: 20 })).firstElementChild as HTMLElement;
    expect(dog.getAttribute("aria-hidden")).toBe("true");
    expect(dog.className).toContain("dog-snooze");
    expect(dog.style.width).toBe("20px");
    expect(dog.textContent).toBe("");
  });
});

describe("a resting account", () => {
  it("sleeps beside a line that recharges until it is back", () => {
    const host = mount(createElement(RestCharge, { rest: { since: at(-HOUR), until: at(HOUR) }, now: NOW }));
    expect(host.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(host.querySelector("[data-recharge]")!.getAttribute("data-recharge")).toBe("50");
    expect(host.textContent).toMatch(/^RechargingBack at [^·]+ · in 1h$/);
  });
});
