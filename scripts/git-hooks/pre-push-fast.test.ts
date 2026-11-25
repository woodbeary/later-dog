import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const head = "4023b874e1477c65580da03d31e739e7cce32d3f";
const base = "1023b874e1477c65580da03d31e739e7cce32d3f";
const zeros = "0".repeat(40);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function checkPush(
  formatFails = false,
  input = `refs/heads/work ${head} refs/heads/work ${base}\n`,
) {
  const bin = mkdtempSync(join(tmpdir(), "laterdog-hook-fixture-"));
  const trace = join(bin, "checks");
  const root = resolve(".");
  const scripts = {
    git: `#!/bin/sh
case "$1" in
  check-ref-format) exit 0 ;;
  rev-parse) if [ "$2" = --show-toplevel ]; then printf '%s\\n' ${quote(root)}; elif [ "$2" = --verify ]; then printf '%s\\n' "\${3%^*}"; else printf '%s\\n' ${head}; fi ;;
  merge-base) printf '%s\\n' ${base} ;;
  diff) if [ "$2" = --name-only ]; then printf 'src/main.tsx\\0README.md\\0'; fi ;;
  ls-files) if [ "$2" = -v ] || [ "$2" = --stage ]; then exit 0; else printf 'src/main.tsx\\0README.md\\0'; fi ;;
  status) exit 0 ;;
  *) exit 2 ;;
esac
`,
    node: `#!/bin/sh
case "$1" in
  */check-push.mjs|scripts/git-hooks/check-push.mjs|*/run-pre-push.mjs|scripts/git-hooks/run-pre-push.mjs) exec ${quote(process.execPath)} "$@" ;;
  *) printf 'comments %s\\n' "$*" >> ${quote(trace)} ;;
esac
`,
    pnpm: `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(trace)}
if [ "$1" = exec ] && [ "$2" = oxfmt ] && [ ${formatFails ? 1 : 0} = 1 ]; then exit 7; fi
exit 0
`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  delete env.LATERDOG_SKIP_HOOKS;
  const result = spawnSync("sh", ["scripts/git-hooks/pre-push"], { input, env, encoding: "utf8" });
  let checks = "";
  try {
    checks = readFileSync(trace, "utf8");
  } catch {}
  return { ...result, checks };
}

describe("changed-file push checks", () => {
  it("checks formatting and lint only for changed supported files", () => {
    const result = checkPush();
    expect(result.status, result.stderr).toBe(0);
    expect(result.checks).toContain("exec oxfmt --check -- ./README.md ./src/main.tsx");
    expect(result.checks).toContain("exec oxlint --deny-warnings -- ./src/main.tsx");
    expect(result.checks).toContain("comments scripts/no-comments.ts --check src/main.tsx");
    expect(result.checks).toContain("typecheck");
    expect(result.checks).toContain("i18n:check");
  });

  it("refuses a push when formatting fails and still collects the other checks", () => {
    const result = checkPush(true);
    expect(result.status).toBe(1);
    expect(result.checks).toContain("typecheck");
    expect(result.checks).toContain("i18n:check");
    expect(result.stderr).toContain("format failed with exit code 7");
  });

  it("refuses to check a pushed commit that is not the checked-out head", () => {
    const result = checkPush(false, `refs/heads/other ${base} refs/heads/other ${zeros}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("check out the commit being pushed");
    expect(result.checks).toBe("");
  });
});
