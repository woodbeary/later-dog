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
  it.each([
    "src/app/[handle]/page.tsx",
    "src/app/api/notifications/[id]/route.ts",
    "src/app/api/operator/refunds/[id]/route.ts",
    "src/app/[...slug]",
    "src/app/[[...slug]]/**",
    "src/app/{draft,published}/page.tsx",
    "src/app/!draft/page.tsx",
    "src/app/[handle]/{draft,published}/!page.tsx",
  ])("accepts literal route scope %s when creating a job", (scope) => {
    expect(scopePath.parse(scope)).toBe(scope);
    expect(createJobSchema.safeParse({ requestKey: "literal-route-1", repository: "a/b", title: "t", brief: "b", writeScopes: [scope] }).success).toBe(true);
    expect(pathInScopes(scope.replace(/\/\*\*$/, ""), [scope])).toBe(true);
  });
  it.each([
    ["src/app/[handle]", "src/app/[handle]/page.tsx", "src/app/123/page.tsx", "src/app/[other]/page.tsx"],
    ["src/app/[...slug]/**", "src/app/[...slug]/page.tsx", "src/app/123/page.tsx", "src/app/[...other]/page.tsx"],
    ["src/app/[[...slug]]/**", "src/app/[[...slug]]/page.tsx", "src/app/123/page.tsx", "src/app/[[...other]]/page.tsx"],
    ["src/app/{draft,published}", "src/app/{draft,published}/page.tsx", "src/app/draft/page.tsx", "src/app/{other}/page.tsx"],
    ["src/app/!draft", "src/app/!draft/page.tsx", "src/app/draft/page.tsx", "src/app/!drafts/page.tsx"],
  ])("matches literal prefix %s at directory boundaries", (scope, inside, ...outside) => {
    expect(pathInScopes(inside, [scope])).toBe(true);
    expect(scopesOverlap([scope], [inside])).toBe(true);
    expect(scopesOverlap([inside], [scope])).toBe(true);
    for (const path of outside) {
      expect(pathInScopes(path, [scope]), path).toBe(false);
      expect(scopesOverlap([scope], [path]), path).toBe(false);
      expect(scopesOverlap([path], [scope]), path).toBe(false);
    }
  });
  it.each([
    "src/app/[handle]/page.tsx",
    "src/app/api/notifications/[id]/route.ts",
    "src/app/api/operator/refunds/[id]/route.ts",
  ])("keeps exact literal scope %s apart from other routes", (scope) => {
    for (const other of [scope.replace(/\[[^\]]+\]/, "123"), scope.replace(/\[[^\]]+\]/, "[other]"), scope + "x"]) {
      expect(pathInScopes(other, [scope])).toBe(false);
      expect(scopesOverlap([scope], [other])).toBe(false);
      expect(scopesOverlap([other], [scope])).toBe(false);
    }
    expect(scopesOverlap([scope], [scope])).toBe(true);
  });
  it("refuses embedded globs, traversal, .git and absolute paths", () => {
    for (const bad of ["src/*.ts", "src/*", "**/x", "a/**/b", "a?b", "", "../x", "a/../b", "../**", ".git", ".git/**", "a/.git/b", "/abs", "/**", "a\\b", "a//b", "a/", "/"]) {
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
