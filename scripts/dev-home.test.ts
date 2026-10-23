import { describe, expect, it } from "vitest";
import { bundleKey, DEV_BUCKET, pointerFor, POINTER_KEY, watchedChange } from "./dev-home.mjs";

describe("pushing server code to test homes", () => {
  it("writes only to the test bucket, under the keys test homes read", () => {
    expect(DEV_BUCKET).toBe("laterdog-homes-test");
    expect(POINTER_KEY).toBe("dev-code/current.json");
    expect(bundleKey("a".repeat(64))).toBe(`dev-code/${"a".repeat(64)}.tgz`);
  });

  it("names each push by what it holds and when", () => {
    expect(pointerFor("c".repeat(64), "6259f1c+local", new Date("2026-10-23T23:00:00Z"))).toEqual({
      hash: "c".repeat(64), label: "6259f1c+local", at: "2026-10-23T23:00:00.000Z",
    });
  });

  it("pushes on server source changes, not on tests or installed packages", () => {
    expect(watchedChange("laterdog/shared-join.ts")).toBe(true);
    expect(watchedChange("model-catalog/models-dev.snapshot.json")).toBe(true);
    expect(watchedChange("laterdog/shared-join.test.ts")).toBe(false);
    expect(watchedChange("node_modules/x/index.ts")).toBe(false);
    expect(watchedChange("notes.md")).toBe(false);
    expect(watchedChange(null)).toBe(false);
  });
});
