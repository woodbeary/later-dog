import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the computer's Chromium policy", () => {
  it("caps the browser's disk cache at 100 MB and still reopens the page left on screen after a sleep", () => {
    const policy = JSON.parse(read("../container/chromium-policy.json")) as Record<string, unknown>;
    expect(policy.DiskCacheSize).toBe(100 * 1024 * 1024);
    expect(policy.RestoreOnStartup).toBe(1);
    expect(read("../container/Dockerfile")).toContain("COPY chromium-policy.json /etc/chromium/policies/managed/laterdog.json");
  });
});
