// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import type { SecureFormCardData } from "../../shared/secure-form";
import { SecureFormCard, secureFormCaption, secureFormReady } from "./SecureFormCard";

const form = (patch: Partial<SecureFormCardData> = {}): SecureFormCardData => ({
  title: "Sign in to Example",
  host: "example.com",
  fields: [
    { id: "email", label: "Email", type: "email" },
    { id: "password", label: "Password", type: "password" },
  ],
  status: "open",
  ...patch,
});

const message = (secureForm: SecureFormCardData): Message => ({
  id: "form-1",
  role: "bot",
  kind: "secret",
  at: 1,
  text: "Secure Form: Sign in to Example (example.com)",
  secureForm,
});

let root: Root | null = null;

function mount(card: SecureFormCardData) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(SecureFormCard, { botId: "pepper", botName: "Pepper", threadId: "pepper-thread", message: message(card) })));
  return host;
}

const card = () => document.querySelector<HTMLElement>("[data-secure-form]")!;
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const openButton = () => document.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]");
const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-secure-field=${id}]`)!;
const continueButton = () => document.querySelector<HTMLButtonElement>("button[type=submit]")!;
const press = (node: HTMLElement) => flushSync(() => node.click());
const type = (field: HTMLInputElement, value: string) => flushSync(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

function fillIn() {
  press(openButton()!);
  type(input("email"), "kit@example.com");
  type(input("password"), " hunter2 ");
}

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the Secure Form card", () => {
  it("sits in the chat as one quiet line with a single Open button", () => {
    mount(form());
    expect(card().getAttribute("aria-label")).toBe("Pepper asks for sign-in details");
    expect(card().dataset.secureForm).toBe("open");
    expect(card().textContent).toContain("Sign in to Example");
    expect(card().textContent).toContain("Secure Form");
    expect(openButton()?.textContent).toBe("Open");
    expect(openButton()?.getAttribute("aria-label")).toBe("Open Secure Form: Sign in to Example");
    expect(dialog()).toBeNull();
  });

  it("opens a sealed form with a labelled field for each detail, starting at the first", () => {
    mount(form());
    press(openButton()!);
    const sheet = dialog()!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(sheet.getAttribute("aria-labelledby")!)?.textContent).toBe("Sign in to Example");
    expect(input("email").type).toBe("email");
    expect(input("email").autocomplete).toBe("off");
    expect(input("password").type).toBe("password");
    expect(input("password").autocomplete).toBe("new-password");
    expect(document.querySelector(`label[for="${input("email").id}"]`)?.textContent).toBe("Email");
    expect(document.querySelector(`label[for="${input("password").id}"]`)?.textContent).toBe("Password");
    expect(document.activeElement).toBe(input("email"));
    expect(sheet.textContent).toContain("Never shown in chat. Only typed into example.com.");
    expect(continueButton().disabled).toBe(true);
  });

  it("lets the person peek at a password and hide it again", () => {
    mount(form());
    press(openButton()!);
    const eye = document.querySelector<HTMLButtonElement>("button[aria-controls]")!;
    expect(eye.getAttribute("aria-controls")).toBe(input("password").id);
    expect(eye.getAttribute("aria-label")).toBe("Show Password");
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    press(eye);
    expect(input("password").type).toBe("text");
    expect(eye.getAttribute("aria-label")).toBe("Hide Password");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    press(eye);
    expect(input("password").type).toBe("password");
  });

  it("only lets the person continue once every field has something in it", () => {
    mount(form());
    press(openButton()!);
    type(input("email"), "   ");
    type(input("password"), "hunter2");
    expect(continueButton().disabled).toBe(true);
    type(input("email"), "kit@example.com");
    expect(continueButton().disabled).toBe(false);
  });

  it("sends the details to later.dog rather than the chat, then closes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ card: form({ status: "sending" }) }), { status: 200 });
    }));
    mount(form());
    fillIn();
    press(continueButton());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(calls).toEqual([{
      url: "/api/bots/pepper/secure-forms/form-1/submit",
      body: { threadId: "pepper-thread", values: { email: "kit@example.com", password: " hunter2 " } },
    }]);
    expect(document.activeElement).toBe(openButton());
  });

  it.each([
    [400, "Something in a field can't be typed into a web page. Check each field."],
    [409, "That didn't go through. Try again."],
    [500, "That didn't go through. Try again."],
  ])("keeps the form open and says so when later.dog answers %i", async (status, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status })));
    mount(form());
    fillIn();
    press(continueButton());
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toBe(text));
    expect(dialog()).not.toBeNull();
    expect(input("email").value).toBe("kit@example.com");
    expect(continueButton().disabled).toBe(false);
  });

  it("closes without sending anything from the close button or Escape", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount(form());
    fillIn();
    press(document.querySelector<HTMLButtonElement>("button[aria-label=Close]")!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(openButton());
    press(openButton()!);
    expect(input("email").value).toBe("");
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["sending", { status: "sending", until: Date.now() + 60_000 }, "Filling in…"],
    ["filled", { status: "filled" }, "Filled"],
    ["expired", { status: "expired" }, "Not filled"],
    ["superseded", { status: "superseded" }, "Not filled"],
    ["expired", { status: "sending", until: Date.now() - 1 }, "Not filled"],
  ] as const)("settles to a quiet %s record once sent", (shown, patch, caption) => {
    mount(form(patch));
    expect(card().dataset.secureForm).toBe(shown);
    expect(card().textContent).toContain(caption);
    expect(openButton()).toBeNull();
  });

  it("stops saying it is filling in once the details are cleared", async () => {
    mount(form({ status: "sending", until: Date.now() + 30 }));
    expect(card().textContent).toContain("Filling in…");
    await vi.waitFor(() => expect(card().dataset.secureForm).toBe("expired"));
    expect(card().textContent).toContain("Not filled");
  });

  it("points a person on another device back to the host computer", () => {
    vi.stubGlobal("laterdog", { remoteClient: { active: true } });
    mount(form());
    expect(openButton()).toBeNull();
    expect(card().textContent).toContain("Open this chat on the host computer to fill this in.");
  });
});

describe("Secure Form wording", () => {
  it("names each state in a word or two", () => {
    expect(["open", "sending", "filled", "expired", "superseded"].map((status) => secureFormCaption(status as SecureFormCardData["status"])))
      .toEqual(["Secure Form", "Filling in…", "Filled", "Not filled", "Not filled"]);
  });

  it("counts a password of spaces as filled in, but not other fields", () => {
    const fields = form().fields;
    expect(secureFormReady(fields, { email: "kit@example.com", password: "  " })).toBe(true);
    expect(secureFormReady(fields, { email: "  ", password: "hunter2" })).toBe(false);
    expect(secureFormReady(fields, { email: "kit@example.com" })).toBe(false);
  });
});
