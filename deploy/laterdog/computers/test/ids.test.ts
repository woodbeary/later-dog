import { describe, expect, it } from "vitest";
import { isComputerId, newComputerId } from "../src/ids";

describe("computer ids", () => {
  it("are cmp_ plus 12 lowercase base32 characters", () => {
    for (let i = 0; i < 200; i++) {
      const id = newComputerId();
      expect(id).toMatch(/^cmp_[a-z2-7]{12}$/);
      expect(isComputerId(id)).toBe(true);
    }
  });

  it("maps every byte value into the alphabet", () => {
    expect(newComputerId((bytes) => bytes.fill(0))).toBe("cmp_aaaaaaaaaaaa");
    expect(newComputerId((bytes) => bytes.fill(255))).toBe("cmp_777777777777");
    expect(newComputerId((bytes) => bytes.fill(31))).toBe("cmp_777777777777");
    expect(newComputerId((bytes) => bytes.fill(32))).toBe("cmp_aaaaaaaaaaaa");
  });

  it("do not repeat", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newComputerId()));
    expect(seen.size).toBe(2000);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "cmp_", "cmp_AAAAAAAAAAAA", "cmp_aaaaaaaaaaa", "cmp_aaaaaaaaaaaaa", "cmp_aaaaaaaaaaa1", "cmp_aaaaaaaaaaa8", "xmp_aaaaaaaaaaaa", " cmp_aaaaaaaaaaaa", "cmp_aaaaaaaaaaaa/"]) {
      expect(isComputerId(bad), bad).toBe(false);
    }
  });
});
