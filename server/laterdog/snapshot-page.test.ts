import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGE_PAGE_MAX, requestedPageSize, SNAPSHOT_PAGE_DEFAULT, snapshotPageSize } from "./snapshot-page.ts";

describe("snapshot page size", () => {
  it("serves the page the apps ask for when nothing is asked for", () => {
    expect(snapshotPageSize(null)).toBe(SNAPSHOT_PAGE_DEFAULT);
    const apps = readFileSync(new URL("../../src/state/store.tsx", import.meta.url), "utf8").match(/export const MESSAGE_PAGE_SIZE = (\d+);/);
    expect(Number(apps?.[1])).toBe(SNAPSHOT_PAGE_DEFAULT);
  });

  it("never serves more than the page cap", () => {
    expect(snapshotPageSize("100000")).toBe(MESSAGE_PAGE_MAX);
    expect(snapshotPageSize("0")).toBe(0);
    expect(snapshotPageSize("40")).toBe(40);
  });

  it("refuses a size it cannot page by", () => {
    expect(snapshotPageSize("-1")).toBeNull();
    expect(snapshotPageSize("lots")).toBeNull();
    expect(snapshotPageSize("1.5")).toBeNull();
  });

  it("leaves an absent size to the caller when it has its own default", () => {
    expect(requestedPageSize(null)).toBeUndefined();
    expect(requestedPageSize("7")).toBe(7);
  });
});
