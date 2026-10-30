// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import type { SecureFormCardData } from "../../shared/secure-form";
import type { VaultOffers } from "../../shared/vault";
import { SecureFormCard, secureFormReady, secureFormStatusLabel } from "./SecureFormCard";

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

function later(offers: VaultOffers | null = null) {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/vault/offers")) {
      return offers ? new Response(JSON.stringify(offers), { status: 200 }) : new Response(JSON.stringify({ error: "no" }), { status: 404 });
    }
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ card: form({ status: "sending" }) }), { status: 200 });
  }));
  return sent;
}

const KIT = { id: "login-1", site: "example.com", username: "kit@example.com", updatedAt: 1 };

function fillIn() {
  press(openButton()!);
  type(input("email"), "kit@example.com");
  type(input("password"), " hunter2 ");
}

beforeEach(() => {
  later();
});

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
    const sent = later();
    mount(form());
    fillIn();
    press(document.querySelector<HTMLButtonElement>("button[aria-label=Close]")!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(openButton());
    press(openButton()!);
    expect(input("email").value).toBe("");
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(sent).toEqual([]);
  });

  it("offers the login saved for the site and fills the form with it, without the person typing", async () => {
    const sent = later({ available: true, logins: [KIT], lookalike: null });
    mount(form());
    press(openButton()!);
    await vi.waitFor(() => expect(document.querySelector("[data-vault-offers]")?.textContent).toContain("kit@example.com"));
    press(document.querySelector<HTMLButtonElement>("button[aria-label='Use the login saved for example.com: kit@example.com']")!);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(sent).toEqual([{ url: "/api/bots/pepper/secure-forms/form-1/submit", body: { threadId: "pepper-thread", login: "login-1" } }]);
  });

  it("lets the dog use the saved login without asking only when the person ticks it", async () => {
    const sent = later({ available: true, logins: [KIT], lookalike: null });
    mount(form());
    press(openButton()!);
    await vi.waitFor(() => expect(document.querySelector("[data-vault-offers]")).not.toBeNull());
    const always = [...document.querySelectorAll("label")].find((label) => label.textContent === "Let Pepper use it on example.com without asking")!;
    press(always.querySelector("input")!);
    press(document.querySelector<HTMLButtonElement>("[data-vault-offers] button")!);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(sent).toEqual([{ url: "/api/bots/pepper/secure-forms/form-1/submit", body: { threadId: "pepper-thread", login: "login-1", always: true } }]);
  });

  it("warns about a site that only looks like one with a saved login, and offers nothing to save there", async () => {
    later({ available: true, logins: [], lookalike: "example.org" });
    mount(form());
    press(openButton()!);
    await vi.waitFor(() => expect(document.querySelector("[data-vault-lookalike]")?.textContent).toContain("This is example.com, not example.org"));
    expect(document.querySelector("[data-vault-offers]")).toBeNull();
    expect(document.querySelector("[data-vault-save]")).toBeNull();
  });

  it("saves a typed login to the vault only when the person ticks Save", async () => {
    const sent = later({ available: true, logins: [], lookalike: null });
    mount(form());
    fillIn();
    await vi.waitFor(() => expect(document.querySelector("[data-vault-save]")).not.toBeNull());
    press(document.querySelector<HTMLInputElement>("[data-vault-save]")!);
    press(continueButton());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(sent).toEqual([{
      url: "/api/bots/pepper/secure-forms/form-1/submit",
      body: { threadId: "pepper-thread", values: { email: "kit@example.com", password: " hunter2 " }, save: true },
    }]);
  });

  it("names the saved login that filled the card", () => {
    mount(form({ status: "sending", until: Date.now() + 60_000, saved: { username: "kit@example.com" } }));
    expect(card().textContent).toContain("Saved login · kit@example.com");
  });

  it.each([
    ["sending", { status: "sending", until: Date.now() + 60_000 }, "Filling in", "muted"],
    ["filled", { status: "filled" }, "Filled", "success"],
    ["expired", { status: "expired" }, "Not filled", "danger"],
    ["superseded", { status: "superseded" }, "Replaced", "muted"],
    ["expired", { status: "sending", until: Date.now() - 1 }, "Not filled", "danger"],
  ] as const)("trades its Open button for a %s badge once sent", (shown, patch, label, tone) => {
    mount(form(patch));
    expect(card().dataset.secureForm).toBe(shown);
    const badge = card().querySelector<HTMLElement>("[data-request-status]")!;
    expect(badge.textContent).toBe(label);
    expect(badge.dataset.requestStatus).toBe(tone);
    expect(openButton()).toBeNull();
  });

  it("opens from anywhere on the card while it waits, and not once it is sent", () => {
    mount(form());
    press(card().querySelector<HTMLElement>("[data-request-card]")!);
    expect(dialog()).not.toBeNull();
    flushSync(() => root?.unmount());
    document.body.innerHTML = "";
    mount(form({ status: "filled" }));
    press(card().querySelector<HTMLElement>("[data-request-card]")!);
    expect(dialog()).toBeNull();
  });

  it("stops saying it is filling in once the details are cleared", async () => {
    mount(form({ status: "sending", until: Date.now() + 30 }));
    expect(card().textContent).toContain("Filling in");
    await vi.waitFor(() => expect(card().dataset.secureForm).toBe("expired"));
    expect(card().textContent).toContain("Not filled");
  });

});

describe("Secure Form wording", () => {
  it("names each settled state in a word or two", () => {
    expect(["open", "sending", "filled", "expired", "superseded"].map((status) => secureFormStatusLabel(status as SecureFormCardData["status"])))
      .toEqual([null, "Filling in", "Filled", "Not filled", "Replaced"]);
  });

  it("counts a password of spaces as filled in, but not other fields", () => {
    const fields = form().fields;
    expect(secureFormReady(fields, { email: "kit@example.com", password: "  " })).toBe(true);
    expect(secureFormReady(fields, { email: "  ", password: "hunter2" })).toBe(false);
    expect(secureFormReady(fields, { email: "kit@example.com" })).toBe(false);
  });
});
