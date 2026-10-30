import { describe, expect, it } from "vitest";
import { savesAsLogin, vaultAllowKey, vaultAllowSite, vaultFieldPlan, vaultSite } from "./vault.ts";

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
