import { describe, expect, it } from "vitest";
import { DEFAULT_REPO, EXPORT_IDENTITY_C, SECRET_NAMES, developerIdNames, parseArguments } from "./laterdog-apple-signing.mjs";

const ISSUER = "57246542-96fe-1a63-e053-0824d011072a";

describe("parseArguments", () => {
  it("reads the key id from Apple's file name and lowercases the issuer", () => {
    const parsed = parseArguments(["/keys/AuthKey_ABCDE12345.p8", ISSUER.toUpperCase()]);
    expect(parsed).toMatchObject({ keyPath: "/keys/AuthKey_ABCDE12345.p8", keyId: "ABCDE12345", issuer: ISSUER, repo: DEFAULT_REPO, identity: undefined });
  });

  it("takes the key id, identity and repository from flags", () => {
    const parsed = parseArguments(["/keys/notarize.p8", ISSUER, "--key-id", "ZYXWV98765", "--identity", "Developer ID Application: Example (TEAM123456)", "--repo", "someone/later-dog"]);
    expect(parsed).toMatchObject({ keyId: "ZYXWV98765", identity: "Developer ID Application: Example (TEAM123456)", repo: "someone/later-dog" });
  });

  it.each([
    [[], /Usage/],
    [["/keys/AuthKey_ABCDE12345.p8"], /Usage/],
    [["/keys/notarize.p8", ISSUER], /AuthKey_<KEY ID>\.p8/],
    [["/keys/AuthKey_ABCDE12345.p8", "not-an-issuer"], /issuer ID/],
    [["/keys/AuthKey_ABCDE12345.p8", ISSUER, "--repo", "no slash"], /Not a GitHub repository/],
    [["/keys/AuthKey_ABCDE12345.p8", ISSUER, "--identity"], /needs a value/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(message);
  });
});

describe("developerIdNames", () => {
  it("keeps only Developer ID Application identities, once each", () => {
    const output = [
      '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: someone@example.com (AAAAAAAAAA)"',
      '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: The Interpreting App, LLC (5JAPUBC2B6)"',
      '  3) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: The Interpreting App, LLC (5JAPUBC2B6)"',
      "     3 valid identities found",
    ].join("\n");
    expect(developerIdNames(output)).toEqual(["Developer ID Application: The Interpreting App, LLC (5JAPUBC2B6)"]);
    expect(developerIdNames("     0 valid identities found")).toEqual([]);
  });
});

describe("the secrets the macOS workflow reads", () => {
  it("names every secret the workflow's Developer ID path uses", async () => {
    const workflow = await import("node:fs").then((fs) => fs.readFileSync(new URL("../.github/workflows/macos.yml", import.meta.url), "utf8"));
    for (const name of SECRET_NAMES) expect(workflow).toContain(`secrets.${name}`);
  });

  it("exports one identity by exact certificate name with a passphrase from the environment", () => {
    expect(EXPORT_IDENTITY_C).toContain("SecItemExport(match, kSecFormatPKCS12");
    expect(EXPORT_IDENTITY_C).toContain('getenv("LATERDOG_P12_OUT")');
    expect(EXPORT_IDENTITY_C).toContain("CFStringCompare(summary, name, 0) == kCFCompareEqualTo");
  });
});
