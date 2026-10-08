import { describe, expect, it } from "vitest";
import { bearerToken, constantTimeEqual, refuseApiRequest, sha256Hex } from "../src/auth";

const KEY = "ldc_0123456789abcdef0123456789abcdef";

describe("sha256Hex", () => {
  it("matches the known digest of the empty string and of a key", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("constantTimeEqual", () => {
  it("compares content and length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("reads the token from a Bearer header", () => {
    expect(bearerToken(`Bearer ${KEY}`)).toBe(KEY);
    expect(bearerToken(`bearer ${KEY}`)).toBe(KEY);
    expect(bearerToken(`Bearer   ${KEY}  `)).toBe(KEY);
  });
  it("rejects other schemes and malformed headers", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken(`Basic ${KEY}`)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(`Bearer ${KEY} extra`)).toBeNull();
  });
});

describe("refuseApiRequest", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("accepts the right key", async () => {
    const digest = await sha256Hex(KEY);
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${KEY}` }), digest)).toBeUndefined();
    // The stored digest may carry stray whitespace or upper case from how it was piped in.
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${KEY}` }), ` ${digest.toUpperCase()}\n`)).toBeUndefined();
  });

  it("refuses a wrong or missing key", async () => {
    const digest = await sha256Hex(KEY);
    expect(await refuseApiRequest(headers({ authorization: "Bearer ldc_wrong" }), digest)).toMatchObject({ status: 401, code: "unauthorized" });
    expect(await refuseApiRequest(headers({}), digest)).toMatchObject({ status: 401, code: "unauthorized" });
    // Presenting the digest itself is not the key.
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${digest}` }), digest)).toMatchObject({ status: 401 });
  });

  it("refuses browser requests before checking the key", async () => {
    const digest = await sha256Hex(KEY);
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${KEY}`, origin: "https://example.com" }), digest)).toMatchObject({
      status: 403,
      code: "browser_origin",
    });
  });

  it("fails closed when the secret is missing or malformed", async () => {
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${KEY}` }), undefined)).toMatchObject({ status: 503, code: "not_configured" });
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${KEY}` }), "")).toMatchObject({ status: 503 });
    expect(await refuseApiRequest(headers({ authorization: `Bearer ${KEY}` }), KEY)).toMatchObject({ status: 503 });
  });
});
