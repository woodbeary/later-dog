import { describe, expect, it } from "vitest";
import { canonicalScope, createJobSchema, pathInScopes, scopePath, scopesOverlap } from "./laterdog.ts";

describe("job write scopes", () => {
  it("treats stored trailing /** scopes as their directory", () => {
    expect(scopesOverlap(["server/laterdog/**"], ["server/laterdog/janitor.ts"])).toBe(true);
    expect(pathInScopes("server/laterdog/engine-files.ts", ["server/laterdog/**"])).toBe(true);
    expect(pathInScopes("server/laterdog", ["server/laterdog/**"])).toBe(true);
  });
  it("serializes canonical and legacy forms of the same directory", () => {
    expect(scopesOverlap(["docs/**"], ["docs"])).toBe(true);
    expect(scopesOverlap(["docs"], ["docs/**"])).toBe(true);
    expect(scopesOverlap(["docs/**"], ["docs/a/**"])).toBe(true);
  });
  it("keeps independent directories apart at the directory boundary", () => {
    expect(scopesOverlap(["server/foo/**"], ["server/foobar"])).toBe(false);
    expect(scopesOverlap(["docs/**"], ["src/**"])).toBe(false);
    expect(pathInScopes("server/foobar/a.ts", ["server/foo/**"])).toBe(false);
    expect(pathInScopes("server/foobar", ["server/foo"])).toBe(false);
  });
  it("accepts exact files, directories and the whole-repository wildcard", () => {
    expect(scopePath.parse("shared/laterdog.ts")).toBe("shared/laterdog.ts");
    expect(scopePath.safeParse("docs/**").success).toBe(true);
    expect(scopePath.safeParse("*").success).toBe(true);
    expect(scopePath.safeParse("**").success).toBe(true);
    expect(canonicalScope("docs/**")).toBe("docs");
    expect(canonicalScope("docs/a/**/**")).toBe("docs/a");
    expect(canonicalScope("*")).toBe("*");
    expect(canonicalScope("**")).toBe("*");
    expect(scopesOverlap(["*"], ["a/b"])).toBe(true);
    expect(pathInScopes("any/file.ts", ["*"])).toBe(true);
    expect(pathInScopes("any/file.ts", ["**"])).toBe(true);
  });
  it("refuses embedded globs, traversal, .git and absolute paths", () => {
    for (const bad of ["src/*.ts", "src/*", "**/x", "a/**/b", "a?b", "a[b]", "a{b,c}", "!a", "../x", "a/../b", "../**", ".git", ".git/**", "a/.git/b", "/abs", "/**", "a\\b", "a//b", "a/", "/"]) {
      expect(scopePath.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("keeps path security refusals for legacy scopes", () => {
    expect(pathInScopes("../x", ["*"])).toBe(false);
    expect(pathInScopes(".git/config", ["**"])).toBe(false);
    expect(pathInScopes("/etc/passwd", ["*"])).toBe(false);
  });
  it("validates scopes when a job is created", () => {
    expect(createJobSchema.safeParse({ requestKey: "request-1", repository: "a/b", title: "t", brief: "b", writeScopes: ["a/*.ts"] }).success).toBe(false);
  });
});
