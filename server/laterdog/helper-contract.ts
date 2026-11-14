import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const HELPER_CONTRACT =
  "You are a helper doing one part of a larger job for one of the person's dogs. Finish it on your own: you cannot ask the person anything, and only your last message goes back to the dog. Begin that message with done, partly done or blocked, then say what you checked yourself and what you took on trust, and give the dog everything it needs to use the result. If two or three different attempts fail, stop and report blocked with what you tried.";

export const SUBAGENT_PROMPT_FLAG = "--append-subagent-system-prompt-file";

const refusedBy = new Set<string>();

const engineKey = (cli: string, version: string) => `${cli}\u0000${version}`;

export function helperContractWanted(cli: string, supportedVersion: string | null): boolean {
  return supportedVersion !== null && !refusedBy.has(engineKey(cli, supportedVersion));
}

export function helperFlagRefused(cli: string, version: string | null, stderr: string, log: (line: string) => void = console.warn): boolean {
  if (version === null || !/unknown option/i.test(stderr) || !stderr.includes(SUBAGENT_PROMPT_FLAG)) return false;
  const key = engineKey(cli, version);
  if (refusedBy.has(key)) return false;
  refusedBy.add(key);
  log(`[engine] ${cli} ${version} does not know ${SUBAGENT_PROMPT_FLAG}; starting it again without it, and leaving it off for this engine`);
  return true;
}

export function helperContractArgs(dir: string): string[] {
  const path = join(dir, "helpers.txt");
  writeFileSync(path, HELPER_CONTRACT, { mode: 0o600 });
  return [SUBAGENT_PROMPT_FLAG, path];
}
