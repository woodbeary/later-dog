import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VAULT_MAX_LOGINS } from "../../shared/vault.ts";
import { cloudVaultKey, lookalikeSite, testVaultKey, VaultInputError, VaultStore } from "./vault.ts";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const LOGIN = { site: "https://accounts.google.com/signin", username: "kit@example.com", password: "correct horse 🔑 battery", note: "Work account" };

let dir: string;
let file: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "laterdog-vault-"));
  file = join(dir, "vault.json");
  clock = 1_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the vault's key", () => {
  it("comes from the home's own secret, the same every start and different for every home", () => {
    const secret = Buffer.alloc(32, 1).toString("base64url");
    const key = cloudVaultKey(secret, "h1");
    expect(key).toHaveLength(32);
    expect(cloudVaultKey(secret, "h1").equals(key)).toBe(true);
    expect(cloudVaultKey(secret, "h2").equals(key)).toBe(false);
    expect(cloudVaultKey(Buffer.alloc(32, 2).toString("base64url"), "h1").equals(key)).toBe(false);
  });

  it("takes a test key only when it is exactly 32 bytes", () => {
    expect(testVaultKey(KEY.toString("base64"))?.equals(KEY)).toBe(true);
    expect(testVaultKey(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(testVaultKey(undefined)).toBeNull();
  });
});

describe("saved logins on disk", () => {
  it("keeps the site, username, password and note sealed, readable only with the key", () => {
    const vault = new VaultStore(file, KEY, now);
    const { login } = vault.save(LOGIN);
    expect(login).toEqual({ id: expect.any(String), site: "google.com", username: "kit@example.com", note: "Work account", updatedAt: 1_000 });
    const raw = readFileSync(file, "utf8");
    for (const plain of ["google", "kit@example.com", "correct horse", "Work account"]) expect(raw).not.toContain(plain);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reopened = new VaultStore(file, KEY, now);
    expect(reopened.view()).toEqual({ available: true, logins: [login] });
    expect(reopened.credentials(login.id)).toEqual({ site: "google.com", username: "kit@example.com", password: "correct horse 🔑 battery" });
  });

  it("stops at a key that does not open it, changes nothing, and says why", () => {
    new VaultStore(file, KEY, now).save(LOGIN);
    const before = readFileSync(file, "utf8");
    const wrong = new VaultStore(file, OTHER_KEY, now);
    expect(wrong.view()).toEqual({ available: false, reason: "unreadable", logins: [] });
    expect(() => wrong.save(LOGIN)).toThrow(VaultInputError);
    expect(wrong.offers("accounts.google.com")).toEqual({ available: false, logins: [], lookalike: null });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a sealed part moved onto another login", () => {
    const vault = new VaultStore(file, KEY, now);
    const first = vault.save(LOGIN).login;
    const second = vault.save({ ...LOGIN, username: "sam@example.com", password: "other" }).login;
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const [a, b] = stored.logins;
    [a.secret, b.secret] = [b.secret, a.secret];
    writeFileSync(file, JSON.stringify(stored));
    const reopened = new VaultStore(file, KEY, now);
    expect(reopened.credentials(first.id)).toBeNull();
    expect(reopened.credentials(second.id)).toBeNull();
  });

  it("is a Cloud feature when the home has no key", () => {
    const vault = new VaultStore(file, null, now);
    expect(vault.view()).toEqual({ available: false, reason: "cloud-only", logins: [] });
    expect(() => vault.save(LOGIN)).toThrow("Saved logins are kept in later.dog Cloud.");
  });
});

describe("the person's own details", () => {
  const DETAILS = { name: "  Kit  Doe ", email: "kit@example.com", tel: "+1 415 555 0100", "address-line1": "1 Main St", "postal-code": "94110", "country-name": "", pet: "Rex" };

  it("keeps them sealed next to the logins, tidied to one line each, and drops empty or unknown ones", () => {
    const vault = new VaultStore(file, KEY, now);
    vault.save(LOGIN);
    const saved = vault.saveDetails(DETAILS);
    expect(saved).toEqual({ name: "Kit Doe", email: "kit@example.com", tel: "+1 415 555 0100", "address-line1": "1 Main St", "postal-code": "94110" });
    const disk = readFileSync(file, "utf8");
    for (const value of ["Kit Doe", "kit@example.com", "555 0100", "Main St", "94110"]) expect(disk).not.toContain(value);
    expect(new VaultStore(file, KEY, now).details()).toEqual({ available: true, details: saved });
    expect(new VaultStore(file, KEY, now).view().logins).toHaveLength(1);
  });

  it("adds what a form taught it to what was there, and clears everything on an empty save", () => {
    const vault = new VaultStore(file, KEY, now);
    vault.saveDetails({ name: "Kit Doe", tel: "555 0100" });
    expect(vault.addDetails({ tel: "555 0199", "address-level2": "Oakland" })).toEqual({ name: "Kit Doe", tel: "555 0199", "address-level2": "Oakland" });
    expect(vault.saveDetails({})).toEqual({});
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("details");
  });

  it("refuses an email that isn't one and a detail that is too long, changing nothing", () => {
    const vault = new VaultStore(file, KEY, now);
    vault.saveDetails({ name: "Kit Doe" });
    expect(() => vault.saveDetails({ email: "kit at example" })).toThrow("That email address doesn't look right.");
    expect(() => vault.saveDetails({ name: "x".repeat(201) })).toThrow(VaultInputError);
    expect(vault.details().details).toEqual({ name: "Kit Doe" });
  });

  it("shows nothing and changes nothing when the vault can't be opened, or is Cloud only", () => {
    new VaultStore(file, KEY, now).saveDetails({ name: "Kit Doe" });
    const wrong = new VaultStore(file, OTHER_KEY, now);
    expect(wrong.details()).toEqual({ available: false, details: {} });
    expect(() => wrong.saveDetails({ name: "Sam" })).toThrow(VaultInputError);
    expect(new VaultStore(file, KEY, now).details().details).toEqual({ name: "Kit Doe" });
    expect(new VaultStore(join(dir, "none.json"), null, now).details()).toEqual({ available: false, details: {} });
  });
});

describe("changing saved logins", () => {
  it("replaces the password of a login it already has and keeps its note", () => {
    const vault = new VaultStore(file, KEY, now);
    const first = vault.save(LOGIN).login;
    clock = 2_000;
    const again = vault.save({ site: "google.com", username: "kit@example.com", password: "new one" });
    expect(again).toEqual({ replaced: true, login: { ...first, updatedAt: 2_000 } });
    expect(vault.credentials(first.id)?.password).toBe("new one");
    expect(vault.view().logins).toHaveLength(1);
  });

  it("edits a login, refusing to make it a copy of another", () => {
    const vault = new VaultStore(file, KEY, now);
    const first = vault.save(LOGIN).login;
    const second = vault.save({ ...LOGIN, username: "sam@example.com" }).login;
    expect(() => vault.update(second.id, { username: "kit@example.com" })).toThrow("You already saved this login.");
    expect(vault.update(first.id, { note: "", password: "changed" })).toMatchObject({ username: "kit@example.com" });
    expect(vault.view().logins.find((login) => login.id === first.id)?.note).toBeUndefined();
    expect(vault.credentials(first.id)?.password).toBe("changed");
    expect(vault.update("missing", { note: "x" })).toBeNull();
  });

  it("removes a login", () => {
    const vault = new VaultStore(file, KEY, now);
    const { login } = vault.save(LOGIN);
    expect(vault.remove(login.id)).toBe(true);
    expect(vault.remove(login.id)).toBe(false);
    expect(new VaultStore(file, KEY, now).view().logins).toEqual([]);
  });

  it.each([
    ["no site", { ...LOGIN, site: "localhost" }, "Use the site's own address"],
    ["no password", { ...LOGIN, password: "" }, "Add the password."],
    ["a password that cannot be typed", { ...LOGIN, password: "two\nlines" }, "cannot be typed"],
    ["a password that is too long", { ...LOGIN, password: "x".repeat(513) }, "too long"],
  ])("refuses a login with %s", (_label, input, message) => {
    expect(() => new VaultStore(file, KEY, now).save(input)).toThrow(message);
  });

  it("notes when a login was last used", () => {
    const vault = new VaultStore(file, KEY, now);
    const { login } = vault.save(LOGIN);
    clock = 5_000;
    vault.credentials(login.id);
    expect(new VaultStore(file, KEY, now).view().logins[0]).toMatchObject({ usedAt: 5_000 });
  });
});

describe("which saved logins a sign-in page gets", () => {
  it("offers the logins for the page's own site and nothing else", () => {
    const vault = new VaultStore(file, KEY, now);
    const google = vault.save(LOGIN).login;
    vault.save({ site: "github.com", username: "kit", password: "gh" });
    expect(vault.offers("mail.google.com")).toEqual({ available: true, logins: [google], lookalike: null });
    expect(vault.matching("google.co.uk")).toEqual([]);
  });

  it("warns about a page that only looks like a site a login is saved for", () => {
    const vault = new VaultStore(file, KEY, now);
    vault.save({ site: "paypal.com", username: "kit", password: "pp" });
    expect(vault.offers("paypa1.com")).toEqual({ available: true, logins: [], lookalike: "paypal.com" });
  });

  it.each([
    ["paypa1.com", "paypal.com"],
    ["paypal-secure-login.com", "paypal.com"],
    ["securepaypal.net", "paypal.com"],
    ["paypal.de", "paypal.com"],
    ["paypai.com", "paypal.com"],
    ["payapl.com", "paypal.com"],
    ["pаypal.com", "paypal.com"],
    ["appleid-support.com", "apple.com"],
  ])("takes %s for %s", (host, saved) => {
    expect(lookalikeSite(host, ["paypal.com", "apple.com", "x.com"])).toBe(saved);
  });

  it.each(["paypal.com", "www.paypal.com", "pineapplefund.org", "google.com", "xbox.com", "app.com"])("leaves %s alone", (host) => {
    expect(lookalikeSite(host, ["paypal.com", "apple.com", "x.com"])).toBeNull();
  });
});

describe("importing logins", () => {
  it("adds new logins, replaces changed passwords and skips copies", () => {
    const vault = new VaultStore(file, KEY, now);
    vault.save({ site: "github.com", username: "kit", password: "old" });
    vault.save({ site: "gitlab.com", username: "kit", password: "same" });
    expect(vault.importLogins([
      { site: "github.com", username: "kit", password: "new" },
      { site: "gitlab.com", username: "kit", password: "same" },
      { site: "example.com", username: "kit", password: "fresh", note: "From 1Password" },
      { site: "localhost", username: "kit", password: "x" },
    ], 2)).toEqual({ added: 1, updated: 1, skipped: 4, full: 0 });
    expect(vault.view().logins.map((login) => login.site)).toEqual(["example.com", "github.com", "gitlab.com"]);
  });

  it(`keeps at most ${VAULT_MAX_LOGINS} logins and counts the rest`, () => {
    const vault = new VaultStore(file, KEY, now);
    const many = Array.from({ length: VAULT_MAX_LOGINS + 3 }, (_, index) => ({ site: `site${index}.com`, username: "kit", password: "pw" }));
    expect(vault.importLogins(many)).toEqual({ added: VAULT_MAX_LOGINS, updated: 0, skipped: 0, full: 3 });
    expect(() => vault.save({ site: "one-more.com", username: "kit", password: "pw" })).toThrow(`up to ${VAULT_MAX_LOGINS} logins`);
  });
});
