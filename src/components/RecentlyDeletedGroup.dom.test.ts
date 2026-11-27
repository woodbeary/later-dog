// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));

import { RecentlyDeletedGroup, type RecentlyDeletedDog } from "./RecentlyDeletedGroup";

let host: HTMLDivElement;
let root: Root;
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Recently deleted in Settings", () => {
  it("shows each deleted dog with the days left and brings one back with Restore", async () => {
    let dogs: RecentlyDeletedDog[] = [{ id: "b", name: "Ledger", at: 0, purgeAt: 30 * DAY }];
    fixture.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === "POST") { expect(path).toBe("/api/recently-deleted/b/restore"); dogs = []; }
      return { dogs };
    });
    await act(async () => root.render(createElement(RecentlyDeletedGroup, { now: () => 2 * DAY })));
    expect(host.textContent).toContain("Recently deleted");
    expect(host.textContent).toContain("Ledger");
    expect(host.textContent).toContain("kept for 28 more days");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-restore="b"]')!.click());
    expect(host.textContent).not.toContain("Ledger");
  });

  it("shows nothing when no dog is in Recently deleted", async () => {
    fixture.api.mockResolvedValue({ dogs: [] });
    await act(async () => root.render(createElement(RecentlyDeletedGroup)));
    expect(host.textContent).toBe("");
  });
});
