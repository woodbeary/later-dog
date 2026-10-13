import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const zeros = "0".repeat(40);
const sha = "4023b874e1477c65580da03d31e739e7cce32d3f";

function prePush(input: string) {
  const env = { ...process.env, PATH: "/usr/bin:/bin" };
  delete env.LATERDOG_SKIP_HOOKS;
  return spawnSync("sh", ["scripts/git-hooks/pre-push"], { input, env, encoding: "utf8" });
}

describe("pre-push hook", () => {
  it("skips the checks when every ref in the push is a deletion", () => {
    const result = prePush(`(delete) ${zeros} refs/heads/old-a ${sha}\n(delete) ${zeros} refs/heads/old-b ${sha}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("only deleting branches");
  });

  it("runs the checks when a branch is pushed", () => {
    const result = prePush(`refs/heads/main ${sha} refs/heads/main ${zeros}\n`);
    expect(result.stdout).toContain("lint, typecheck, locale check");
    expect(result.status).not.toBe(0);
  });
});
