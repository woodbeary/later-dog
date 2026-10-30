import { describe, expect, it } from "vitest";
import { vaultMatches } from "./VaultSettings";

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
