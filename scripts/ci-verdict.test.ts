import { describe, expect, it } from "vitest";
import { ALWAYS_RUN, RUNTIME_JOBS, judgeNeeds, main } from "./ci-verdict.mjs";

const needs = (overrides: Record<string, string> = {}, runtime = "true") =>
  Object.fromEntries([...ALWAYS_RUN, ...RUNTIME_JOBS].map((name) => [name, { result: overrides[name] ?? "success", outputs: name === "scope" ? { runtime } : {} }]));

describe("the CI verdict", () => {
  it("passes when every job succeeded", () => {
    expect(judgeNeeds(needs())).toMatchObject({ ok: true, docsOnly: false });
  });

  it("fails on a failed, cancelled or missing job", () => {
    expect(judgeNeeds(needs({ suite: "failure" })).problems).toEqual(["suite failure"]);
    expect(judgeNeeds(needs({ lint: "cancelled" })).problems).toEqual(["lint cancelled"]);
    const missing = needs();
    delete (missing as Record<string, unknown>).interface;
    expect(judgeNeeds(missing).problems).toEqual(["interface is missing"]);
  });

  it("accepts skipped runtime jobs only when the scope selected docs-only", () => {
    const skipped = Object.fromEntries(RUNTIME_JOBS.map((name) => [name, "skipped"]));
    expect(judgeNeeds(needs(skipped, "false"))).toMatchObject({ ok: true, docsOnly: true });
    expect(judgeNeeds(needs(skipped, "true")).ok).toBe(false);
  });

  it("never accepts a skipped static job, even on a docs-only change", () => {
    expect(judgeNeeds(needs({ lint: "skipped" }, "false")).problems).toEqual(["lint skipped"]);
    expect(judgeNeeds(needs({ typecheck: "skipped" }, "false")).ok).toBe(false);
  });

  it("fails when the scope gave no answer", () => {
    expect(judgeNeeds(needs({}, "")).ok).toBe(false);
  });

  it("exits 1 for unreadable input and 0 for a pass", () => {
    expect(main({ NEEDS: "nope" })).toBe(1);
    expect(main({ NEEDS: JSON.stringify(needs()) })).toBe(0);
    expect(main({ NEEDS: JSON.stringify(needs({ build: "failure" })) })).toBe(1);
  });
});
