import { expect, it } from "vitest";

it("exposes a hidden runtime failure", () => {
  expect(true).toBe(false);
});
