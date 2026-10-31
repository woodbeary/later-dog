// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultDetailsGroup, vaultMatches } from "./VaultSettings";

const login = { id: "a", site: "github.com", username: "kit@example.com", note: "Work account", updatedAt: 1 };

describe("searching saved logins", () => {
  it("matches every word against the site, username and note", () => {
    expect(vaultMatches(login, "git")).toBe(true);
    expect(vaultMatches(login, "KIT work")).toBe(true);
    expect(vaultMatches(login, "  ")).toBe(true);
    expect(vaultMatches(login, "gitlab")).toBe(false);
    expect(vaultMatches({ ...login, note: undefined }, "work")).toBe(false);
  });
});

describe("the person's details in the vault", () => {
  let root: Root | null = null;
  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  const field = (key: string) => document.querySelector<HTMLInputElement>(`[data-vault-detail='${key}']`)!;
  const save = () => document.querySelector<HTMLButtonElement>("[data-vault-details] button[type=submit]")!;

  it("shows what's saved, and saves a change only once something changed", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ details: { name: "Kit Doe", tel: "555 0199" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ available: true, details: { name: "Kit Doe", tel: "555 0100" } }), { status: 200 });
    }));
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => root!.render(createElement(VaultDetailsGroup)));
    await vi.waitFor(() => expect(field("name")?.value).toBe("Kit Doe"));
    expect(field("tel").placeholder).toBe("Phone");
    expect(save().disabled).toBe(true);
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field("tel"), "555 0199");
      field("tel").dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save().disabled).toBe(false);
    flushSync(() => save().click());
    await vi.waitFor(() => expect(document.querySelector("[data-vault-details] [role=status]")?.textContent).toBe("Saved"));
    expect(sent).toEqual([{ details: { name: "Kit Doe", tel: "555 0199" } }]);
    expect(save().disabled).toBe(true);
  });

  it("stays out of the way where the vault isn't available", async () => {
    const asked = vi.fn(async () => new Response(JSON.stringify({ available: false, details: {} }), { status: 200 }));
    vi.stubGlobal("fetch", asked);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => root!.render(createElement(VaultDetailsGroup)));
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    expect(host.querySelector("[data-vault-details]")).toBeNull();
  });
});
