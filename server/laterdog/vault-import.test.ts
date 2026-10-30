import { describe, expect, it } from "vitest";
import { importedLogins, parseCsv, VAULT_IMPORT_ROWS } from "./vault-import.ts";

describe("reading a CSV file", () => {
  it("handles quotes, commas, line breaks and doubled quotes inside a field", () => {
    expect(parseCsv("﻿a,b,c\r\n\"x, y\",\"say \"\"hi\"\"\",\"two\nlines\"\n\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["x, y", "say \"hi\"", "two\nlines"],
      ["1", "", "3"],
    ]);
  });
});

describe("logins from a password manager's export", () => {
  it("reads 1Password's columns", () => {
    const csv = "Title,Website,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n" +
      "GitHub,https://github.com/login,kit,\"p,a\"\"ss\",,false,false,,Work\n" +
      "Router,http://192.168.1.1,admin,admin,,false,false,,\n";
    expect(importedLogins(csv)).toEqual({
      logins: [{ site: "github.com", username: "kit", password: "p,a\"ss", note: "Work" }],
      skipped: 1,
    });
  });

  it("reads Chrome's and Safari's columns", () => {
    expect(importedLogins("name,url,username,password,note\naccounts.google.com,https://accounts.google.com/,kit@example.com,pw,\n"))
      .toEqual({ logins: [{ site: "google.com", username: "kit@example.com", password: "pw" }], skipped: 0 });
    expect(importedLogins("Title,URL,Username,Password,Notes,OTPAuth\nApple,https://appleid.apple.com,kit,pw,,\n"))
      .toEqual({ logins: [{ site: "apple.com", username: "kit", password: "pw" }], skipped: 0 });
  });

  it("reads Bitwarden's columns and skips cards and notes", () => {
    const csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n" +
      ",,login,Example,,,0,https://example.com,kit,pw,\n" +
      ",,card,Visa,,,0,,,,\n" +
      ",,note,Secret,text,,0,,,,\n";
    expect(importedLogins(csv)).toEqual({ logins: [{ site: "example.com", username: "kit", password: "pw" }], skipped: 2 });
  });

  it("keeps a password exactly as exported, spaces and all", () => {
    expect(importedLogins("url,username,password\nexample.com,kit,  spaced  \n")).toEqual({
      logins: [{ site: "example.com", username: "kit", password: "  spaced  " }],
      skipped: 0,
    });
  });

  it("takes the first of several addresses", () => {
    expect(importedLogins("url,username,password\n\"https://a.example.com, https://b.example.org\",kit,pw\n"))
      .toEqual({ logins: [{ site: "example.com", username: "kit", password: "pw" }], skipped: 0 });
  });

  it("refuses a file without website and password columns", () => {
    expect(importedLogins("name,email\nKit,kit@example.com\n")).toEqual({ error: expect.stringContaining("doesn't look like a password export") });
    expect(importedLogins("")).toEqual({ error: expect.stringContaining("doesn't look like a password export") });
  });

  it(`reads at most ${VAULT_IMPORT_ROWS} rows and counts the rest as skipped`, () => {
    const rows = Array.from({ length: VAULT_IMPORT_ROWS + 2 }, (_, index) => `site${index}.com,kit,pw`).join("\n");
    const result = importedLogins(`url,username,password\n${rows}\n`);
    expect("logins" in result && result.logins.length).toBe(VAULT_IMPORT_ROWS);
    expect("logins" in result && result.skipped).toBe(2);
  });
});
