// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanProvider } from "./PlanUsage";
import { UsageNotice, usageNoticeWords } from "./UsageNotice";
import { USAGE_NOTICE_DISMISSED_KEY, usageNoticeFor } from "@/lib/usage-notice";
import { setLocale } from "@/lib/i18n";

const window = (usedPercent: number | null, resetsAt: string | null = null) => ({ available: usedPercent !== null, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetsAt });
const account = (weekly: number | null, fiveHour: number | null = null, fiveHourResets = "2026-11-17T15:00:00"): PlanProvider => ({
  id: "claude", name: "Claude", driver: "claudeAgent", plan: "max", ok: true, error: null,
  weekly: window(weekly, "2026-11-20T09:00:00"), fiveHour: window(fiveHour, fiveHourResets), extra: [],
});

let host: HTMLDivElement;
let root: Root;
const render = async (provider: PlanProvider | undefined, onOpen = vi.fn()) => {
  await act(async () => root.render(createElement(UsageNotice, { provider, onOpen })));
  return onOpen;
};
const remount = async (provider: PlanProvider) => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(provider);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the usage row in the composer", () => {
  it("shows nothing at 74 % and one plain sentence at 75 %", async () => {
    await render(account(74));
    expect(host.querySelector("[data-usage-notice]")).toBeNull();
    await render(account(75));
    expect(host.querySelector("[data-usage-notice]")!.textContent).toBe("Most of this week's use is gone");
  });

  it("says almost all at 90 % and shows nothing once the use is gone", async () => {
    await render(account(90));
    expect(host.textContent).toBe("Almost all of this week's use is gone");
    await render(account(100));
    expect(host.querySelector("[data-usage-notice]")).toBeNull();
  });

  it("names the five-hour reset time when that window is the higher one", () => {
    expect(usageNoticeWords(account(40, 80))).toBe("Most of your use until 3 PM is gone");
    expect(usageNoticeWords(account(80, 95))).toBe("Almost all of your use until 3 PM is gone");
    expect(usageNoticeWords(account(91, 80))).toBe("Almost all of this week's use is gone");
  });

  it("opens the usage view on a click", async () => {
    const onOpen = await render(account(80));
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-usage-notice-open]")!.click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("hides on × until the next threshold, also after a reload", async () => {
    await render(account(80));
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-usage-notice-hide]")!.click(); });
    expect(host.querySelector("[data-usage-notice]")).toBeNull();
    expect(localStorage.getItem(USAGE_NOTICE_DISMISSED_KEY)).toBe(usageNoticeFor(account(80))!.key);
    await remount(account(82));
    expect(host.querySelector("[data-usage-notice]")).toBeNull();
    await remount(account(91));
    expect(host.textContent).toBe("Almost all of this week's use is gone");
  });

  it("comes back after the window resets", async () => {
    await render(account(null, 80, "2026-11-17T15:00:00"));
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-usage-notice-hide]")!.click(); });
    await remount(account(null, 80, "2026-11-17T20:00:00"));
    expect(host.textContent).toBe("Most of your use until 8 PM is gone");
  });

  it("shows nothing for an account whose usage could not be read", async () => {
    await render({ ...account(80), ok: false });
    expect(host.querySelector("[data-usage-notice]")).toBeNull();
  });
});
