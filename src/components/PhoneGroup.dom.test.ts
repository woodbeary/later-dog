// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));

import { PhoneGroup, type PhoneStatus } from "./PhoneGroup";

const ALL = ["calendar", "reminders", "contacts", "location", "add_calendar_event", "add_reminder"];
const iphone: PhoneStatus = { id: "p1", name: "Jo's iPhone", online: true, can: ALL, lastSeenAt: 1 };
let host: HTMLDivElement;
let root: Root;

async function show(phones: PhoneStatus[] | Error) {
  fixture.api.mockImplementation(async () => {
    if (phones instanceof Error) throw phones;
    return { phones };
  });
  await act(async () => root.render(createElement(PhoneGroup)));
}

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

describe("Your iPhone in Settings", () => {
  it("shows a connected iPhone and what dogs can use on it", async () => {
    await show([iphone]);
    expect(fixture.api).toHaveBeenCalledWith("/api/phone/device", { timeoutMs: 5_000 });
    expect(host.textContent).toContain("Your iPhone");
    expect(host.textContent).toContain("Jo's iPhone");
    expect(host.textContent).toContain("Dogs can use its calendar, reminders, contacts and location when you ask.");
    expect(host.querySelector('[data-phone-online="true"]')!.textContent).toBe("Connected");
  });

  it("says how to reach a phone that isn't connected, and asks an old app to update", async () => {
    await show([{ ...iphone, online: false }, { ...iphone, id: "p2", name: "Old iPhone", can: [] }]);
    expect(host.textContent).toContain("Your iPhones");
    expect(host.textContent).toContain("Dogs ask you to open later.dog on it when they need it.");
    expect(host.querySelector('[data-phone-online="false"]')!.textContent).toBe("Not connected");
    expect(host.textContent).toContain("Update later.dog on this iPhone so dogs can use its calendar, reminders, contacts and location.");
  });

  it("shows nothing without a phone, or when the home can't say", async () => {
    await show([]);
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(new Error("offline"));
    expect(host.textContent).toBe("");
  });
});
