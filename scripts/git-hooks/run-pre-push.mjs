import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function finishPrePush(result, seconds, stdout = process.stdout, stderr = process.stderr) {
  const error =
    result.error?.message ||
    result.signal ||
    (result.status === 0 ? null : `exit code ${result.status}`);
  if (error) stderr.write(`pre-push: checks failed with ${error}\n`);
  if (seconds >= 9)
    stderr.write(
      `pre-push: complete invocation ${seconds.toFixed(2)}s reaches or exceeds the 9s budget\n`,
    );
  stdout.write(`pre-push: complete invocation finished in ${seconds.toFixed(2)}s\n`);
  return error || seconds >= 9 ? 1 : 0;
}

export function runPrePush() {
  let result;
  try {
    result = spawnSync("sh", [fileURLToPath(new URL("./pre-push-checks", import.meta.url))], {
      stdio: "inherit",
    });
  } catch (error) {
    result = { error };
  }
  return finishPrePush(result, process.uptime());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runPrePush();
