import { pathToFileURL } from "node:url";

export const ALWAYS_RUN = ["scope", "lint", "typecheck"];
export const RUNTIME_JOBS = ["build", "electron-broker", "suite", "side", "interface"];

export function judgeNeeds(needs) {
  const problems = [];
  const docsOnly = needs?.scope?.outputs?.runtime === "false";
  if (
    needs?.scope?.result === "success" &&
    !["true", "false"].includes(needs.scope.outputs?.runtime)
  ) {
    problems.push("scope did not say whether runtime checks are selected");
  }
  for (const name of [...ALWAYS_RUN, ...RUNTIME_JOBS]) {
    const result = needs?.[name]?.result;
    if (result === undefined) problems.push(`${name} is missing`);
    else if (result === "success") continue;
    else if (result === "skipped" && RUNTIME_JOBS.includes(name) && docsOnly) continue;
    else problems.push(`${name} ${result}`);
  }
  return { ok: problems.length === 0, docsOnly, problems };
}

export function main(env) {
  let needs;
  try {
    needs = JSON.parse(env.NEEDS ?? "");
  } catch {
    process.stdout.write("CI: the needed jobs were not readable\n");
    return 1;
  }
  const verdict = judgeNeeds(needs);
  if (!verdict.ok) {
    process.stdout.write(
      `CI failed:\n${verdict.problems.map((problem) => `  ${problem}`).join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    verdict.docsOnly
      ? "CI passed: docs-only change, runtime jobs skipped by the scope selection\n"
      : "CI passed: every job succeeded\n",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.env);
}
