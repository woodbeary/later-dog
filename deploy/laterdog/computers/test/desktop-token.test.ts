import { describe, expect, it } from "vitest";
import { DESKTOP_LINK_TTL_SECONDS, base64url, fromBase64url, signDesktopToken, verifyDesktopToken } from "../src/desktop-token";

const SECRET = "test-signing-key-7f3a";
const ID = "cmp_abcdefghij23";
const NOW = 1_800_000_000;

async function issue(overrides: { id?: string; generation?: number; expiresAt?: number; secret?: string } = {}) {
  return signDesktopToken(overrides.secret ?? SECRET, overrides.id ?? ID, overrides.generation ?? 3, overrides.expiresAt ?? NOW + DESKTOP_LINK_TTL_SECONDS);
}

describe("desktop tokens", () => {
  it("look like <expiresAt>.<43 base64url characters>", async () => {
    expect(await issue()).toMatch(new RegExp(`^${NOW + DESKTOP_LINK_TTL_SECONDS}\\.[A-Za-z0-9_-]{43}$`));
  });

  it("verify for the same computer, generation and secret before expiry", async () => {
    const token = await issue();
    expect(await verifyDesktopToken(SECRET, ID, 3, token, NOW)).toBe("valid");
    expect(await verifyDesktopToken(SECRET, ID, 3, token, NOW + DESKTOP_LINK_TTL_SECONDS - 1)).toBe("valid");
  });

  it("expire at their expiry time", async () => {
    const token = await issue();
    expect(await verifyDesktopToken(SECRET, ID, 3, token, NOW + DESKTOP_LINK_TTL_SECONDS)).toBe("expired");
    expect(await verifyDesktopToken(SECRET, ID, 3, token, NOW + 10 * DESKTOP_LINK_TTL_SECONDS)).toBe("expired");
  });

  it("die when the computer boots again (new generation)", async () => {
    const token = await issue({ generation: 3 });
    expect(await verifyDesktopToken(SECRET, ID, 4, token, NOW)).toBe("invalid");
    expect(await verifyDesktopToken(SECRET, ID, 2, token, NOW)).toBe("invalid");
  });

  it("do not open another computer", async () => {
    const token = await issue();
    expect(await verifyDesktopToken(SECRET, "cmp_abcdefghij24", 3, token, NOW)).toBe("invalid");
  });

  it("do not verify under another secret", async () => {
    const token = await issue({ secret: "another-secret" });
    expect(await verifyDesktopToken(SECRET, ID, 3, token, NOW)).toBe("invalid");
  });

  it("cannot have their expiry moved", async () => {
    const token = await issue();
    const [, mac] = token.split(".");
    expect(await verifyDesktopToken(SECRET, ID, 3, `${NOW + DESKTOP_LINK_TTL_SECONDS + 30}.${mac}`, NOW)).toBe("invalid");
    // An expiry further out than any link this Worker issues is refused before the MAC is checked.
    const farFuture = await issue({ expiresAt: NOW + 30 * 24 * 3600 });
    expect(await verifyDesktopToken(SECRET, ID, 3, farFuture, NOW)).toBe("invalid");
  });

  it("reject tampered and malformed tokens", async () => {
    const token = await issue();
    // Change the first MAC character (the last one partly carries padding bits).
    const at = token.indexOf(".") + 1;
    const flipped = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    for (const bad of [flipped, "", "abc", `${NOW}`, `${NOW}.`, `x${token}`, `${token}x`, token.replace(".", "-"), `-1.${token.split(".")[1]}`]) {
      expect(await verifyDesktopToken(SECRET, ID, 3, bad, NOW), bad).toBe("invalid");
    }
  });

  it("refuse to sign or verify without a secret", async () => {
    await expect(signDesktopToken("", ID, 1, NOW + 60)).rejects.toThrow(/DESKTOP_SIGNING_KEY/);
    const token = await issue();
    await expect(verifyDesktopToken("", ID, 3, token, NOW)).rejects.toThrow(/DESKTOP_SIGNING_KEY/);
  });
});

describe("base64url", () => {
  it("round-trips bytes", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 250) & 255);
      expect(fromBase64url(base64url(bytes))).toEqual(bytes);
    }
  });
  it("rejects non-base64url text", () => {
    expect(fromBase64url("ab+c")).toBeUndefined();
    expect(fromBase64url("abcde")).toBeUndefined();
  });
});
