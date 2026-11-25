import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => {
  vi.resetModules();
  return [] as Array<{
    callback: (error: Error | null, stdout: string) => void;
    child: { kill: ReturnType<typeof vi.fn> };
  }>;
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("a completion callback is required");
      const child = { kill: vi.fn(() => true) };
      probes.push({ callback: callback as (error: Error | null, stdout: string) => void, child });
      return child;
    }),
  };
});

import { augmentedPath, resetPathCache, resetPathCacheForTests } from "./env-path.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("LATERDOG_TEST_SEALED_PATH", undefined);
  vi.stubEnv("PATH", "/path-probe-base");
  resetPathCacheForTests();
});

afterEach(() => {
  resetPathCacheForTests();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
  probes.length = 0;
});

describe("login-shell probe ownership", () => {
  it("keeps a delayed result out of a cleared sealed path", () => {
    augmentedPath();
    expect(probes).toHaveLength(1);
    resetPathCacheForTests();
    vi.stubEnv("LATERDOG_TEST_SEALED_PATH", "1");
    const sealed = augmentedPath();
    probes[0].callback(null, "__LATERDOG_PATH__/path-probe-obsolete\n");
    expect(augmentedPath().split(delimiter)).not.toContain("/path-probe-obsolete");
    expect(augmentedPath()).toBe(sealed);
  });

  it("stops the pending child when its path cache is reset", () => {
    augmentedPath();
    const child = probes[0].child;
    resetPathCacheForTests();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps the last resolved path during a rescan and ignores an older rescan result", () => {
    augmentedPath();
    probes[0].callback(null, "__LATERDOG_PATH__/path-probe-resolved\n");
    resetPathCache();
    expect(augmentedPath().split(delimiter)).toContain("/path-probe-resolved");
    const obsolete = probes[1];
    resetPathCache();
    augmentedPath();
    probes[2].callback(null, "__LATERDOG_PATH__/path-probe-current\n");
    obsolete.callback(null, "__LATERDOG_PATH__/path-probe-obsolete\n");
    expect(augmentedPath().split(delimiter)).toContain("/path-probe-current");
    expect(augmentedPath().split(delimiter)).not.toContain("/path-probe-obsolete");
  });

  it("ignores a pending result when the fixture becomes sealed", () => {
    augmentedPath();
    vi.stubEnv("LATERDOG_TEST_SEALED_PATH", "1");
    probes[0].callback(null, "__LATERDOG_PATH__/path-probe-obsolete\n");
    expect(augmentedPath().split(delimiter)).not.toContain("/path-probe-obsolete");
  });

  it("releases a completed failed probe without stopping it again", () => {
    augmentedPath();
    const probe = probes[0];
    probe.callback(new Error("the shell failed"), "");
    resetPathCacheForTests();
    expect(probe.child.kill).not.toHaveBeenCalled();
  });
});
