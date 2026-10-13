// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [], groups: [], activeView: "chat" } }) }));

import { BugReportDialog } from "./BugReportDialog";

const happened = `Start ${"🧪".repeat(700)} complete description`;
const expected = "The complete report should be available to paste.";
let host: HTMLDivElement;
let root: Root;
let nativeCopy: ReturnType<typeof vi.fn>;
let webCopy: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;
const copyButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Copy full report")!;
const type = async (field: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  nativeCopy = vi.fn(async () => true);
  webCopy = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
  openExternal = vi.fn();
  vi.stubGlobal("navigator", { userAgent: "fixture", clipboard: { writeText: webCopy } });
  vi.stubGlobal("laterdog", { copyText: nativeCopy, openExternal, platform: "darwin" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(BugReportDialog, { onClose: vi.fn() })));
  const fields = document.querySelectorAll("textarea");
  await type(fields[0]!, happened);
  await type(fields[1]!, expected);
  expect(copyButton()).toBeDefined();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("copying a shortened bug report", () => {
  it.each(["denied", "unavailable"] as const)("copies the full report through the desktop fallback when the browser clipboard is %s", async (clipboard) => {
    if (clipboard === "unavailable") vi.stubGlobal("navigator", { userAgent: "fixture" });
    await act(async () => copyButton().click());
    expect(nativeCopy).toHaveBeenCalledTimes(1);
    const copied = nativeCopy.mock.calls[0]![0] as string;
    expect(copied).toContain(`**What happened**\n\n${happened}`);
    expect(copied).toContain(`**What you expected**\n\n${expected}`);
    expect(copied).not.toContain("Conversation ID");
    if (clipboard === "denied") expect(webCopy).toHaveBeenCalledWith(copied);
    else expect(webCopy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("shows a failed copy and lets a successful retry clear it without losing the report", async () => {
    nativeCopy.mockResolvedValueOnce(false);
    await act(async () => copyButton().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not copy");
    expect(document.querySelector("textarea")?.value).toBe(happened);
    await act(async () => copyButton().click());
    expect(nativeCopy).toHaveBeenCalledTimes(2);
    expect(nativeCopy.mock.calls[1]).toEqual(nativeCopy.mock.calls[0]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
