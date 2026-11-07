import { describe, expect, it } from "vitest";
import type { VaultLogin } from "../../shared/vault.ts";
import { vaultInput, withoutSecret, type VaultSource } from "./vault-input.ts";

const login = (id: string, site: string, username: string): VaultLogin => ({ id, site, username, updatedAt: 1 });
const SAVED: Record<string, string> = { l1: "hunter2", l2: "correct horse", l3: "other" };
const vault = (logins: VaultLogin[]): VaultSource => ({
  list: () => logins,
  matching: (host) => logins.filter((each) => each.site === host.toLowerCase()),
  credentials: (id) => {
    const found = logins.find((each) => each.id === id);
    return found ? { site: found.site, username: found.username, password: SAVED[id]! } : null;
  },
});

describe("typing a saved vault password into a Mac command", () => {
  const logins = [login("l1", "jammy", "jacob"), login("l2", "wifi2", "admin"), login("l3", "wifi2", "guest")];

  it("types the saved password and a return, for sudo -S or a login prompt", () => {
    expect(vaultInput(vault(logins), "jammy")).toEqual({ ok: true, input: "hunter2\n", secret: "hunter2", username: "jacob" });
    expect(vaultInput(vault(logins), "l2")).toMatchObject({ ok: true, input: "correct horse\n" });
    expect(vaultInput(vault(logins), "guest@wifi2")).toMatchObject({ ok: true, input: "other\n", username: "guest" });
  });

  it("asks which one when a site has two logins, and names the saved sites when nothing matches", () => {
    expect(vaultInput(vault(logins), "wifi2")).toEqual({ ok: false, error: "More than one login is saved for wifi2; name it as username@wifi2." });
    const missing = vaultInput(vault(logins), "router");
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toContain("Saved sites: jammy, wifi2.");
  });

  it("never lets the password back out in what the dog sees", () => {
    const result = { output: "Password:hunter2\nok", nested: [{ line: "hunter2" }], exitCode: 0 };
    expect(withoutSecret(result, "hunter2")).toEqual({ output: "Password:••••\nok", nested: [{ line: "••••" }], exitCode: 0 });
    expect(JSON.stringify(withoutSecret(result, "hunter2"))).not.toContain("hunter2");
  });
});
