import { describe, expect, it } from "vitest";
import { detailsFill, detailsFromForm, detailValue, savesAsLogin, vaultAllowKey, vaultAllowSite, vaultFieldPlan, vaultSite } from "./vault.ts";

describe("the site a login is saved for", () => {
  it.each([
    ["accounts.google.com", "google.com"],
    ["https://www.Example.com/login?next=/", "example.com"],
    ["signin.aws.amazon.com", "amazon.com"],
    ["news.bbc.co.uk", "bbc.co.uk"],
    ["my-team.github.io", "my-team.github.io"],
    ["docs.my-team.github.io", "my-team.github.io"],
  ])("files %s under %s", (host, site) => {
    expect(vaultSite(host)).toBe(site);
  });

  it.each(["github.io", "co.uk", "localhost", "192.168.1.10", "not a host", "", 7])("has no site for %j", (host) => {
    expect(vaultSite(host)).toBeNull();
  });

  it("names a dog's permission by the site and reads it back", () => {
    expect(vaultAllowKey("google.com")).toBe("vault:google.com");
    expect(vaultAllowSite("vault:google.com")).toBe("google.com");
    expect(vaultAllowSite("connector:gmail")).toBeNull();
  });
});

describe("which Secure Forms a saved login can fill", () => {
  const field = (id: string, type: "text" | "email" | "password" | "code") => ({ id, type });

  it("fills a username and a password, or either one alone for a two-step sign-in", () => {
    expect(vaultFieldPlan([field("email", "email"), field("pass", "password")])).toEqual({ username: "email", password: "pass" });
    expect(vaultFieldPlan([field("user", "text")])).toEqual({ username: "user" });
    expect(vaultFieldPlan([field("pass", "password")])).toEqual({ password: "pass" });
  });

  it("leaves forms with a code, or with two of anything, to the person", () => {
    expect(vaultFieldPlan([field("email", "email"), field("code", "code")])).toBeNull();
    expect(vaultFieldPlan([field("first", "text"), field("last", "text"), field("pass", "password")])).toBeNull();
    expect(vaultFieldPlan([field("old", "password"), field("new", "password")])).toBeNull();
    expect(vaultFieldPlan([])).toBeNull();
  });

  it("offers to save only a form with both a username and a password", () => {
    expect(savesAsLogin([field("email", "email"), field("pass", "password")])).toBe(true);
    expect(savesAsLogin([field("pass", "password")])).toBe(false);
    expect(savesAsLogin([field("email", "email")])).toBe(false);
  });
});

describe("filling a form from the person's details", () => {
  const DETAILS = { name: "Kit van Doe", email: "kit@example.com", "address-line1": "1 Main St", "address-line2": "Apt 4", "postal-code": "94110" };

  it("splits the full name and joins the address lines when a box wants them that way", () => {
    expect(detailValue(DETAILS, "given-name")).toBe("Kit van");
    expect(detailValue(DETAILS, "family-name")).toBe("Doe");
    expect(detailValue({ name: "Cher" }, "given-name")).toBe("Cher");
    expect(detailValue({ name: "Cher" }, "family-name")).toBe("");
    expect(detailValue(DETAILS, "street-address")).toBe("1 Main St, Apt 4");
    expect(detailValue(DETAILS, "tel")).toBe("");
  });

  it("fills only the boxes it has a detail for", () => {
    const fields = [
      { id: "first", autocomplete: "given-name" as const },
      { id: "phone", autocomplete: "tel" as const },
      { id: "zip", autocomplete: "postal-code" as const },
      { id: "note" },
    ];
    expect(detailsFill(fields, DETAILS)).toEqual({ first: "Kit van", zip: "94110" });
  });

  it("learns back only the details it keeps as they are", () => {
    const fields = [
      { id: "first", autocomplete: "given-name" as const },
      { id: "email", autocomplete: "email" as const },
      { id: "zip", autocomplete: "postal-code" as const },
      { id: "note" },
    ];
    expect(detailsFromForm(fields, new Map([["first", "Kit"], ["email", " kit@example.com "], ["zip", "94110"], ["note", "x"]])))
      .toEqual({ email: "kit@example.com", "postal-code": "94110" });
  });

  it("never treats a form asking for contact details as a sign-in", () => {
    expect(vaultFieldPlan([{ id: "name", type: "text", autocomplete: "name" }, { id: "email", type: "email", autocomplete: "email" }])).toBeNull();
    expect(vaultFieldPlan([{ id: "email", type: "email", autocomplete: "email" }, { id: "password", type: "password" }])).toEqual({ username: "email", password: "password" });
  });
});
