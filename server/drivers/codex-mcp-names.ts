import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*[.\]]/gm;

export function mcpServerNamesInToml(toml: string): Set<string> {
  const names = new Set<string>();
  for (const match of toml.matchAll(HEADER)) {
    const name = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3];
    if (name) names.add(name);
  }
  return names;
}

export function codexConfigMcpServerNames(env: Record<string, string | undefined>): Set<string> {
  const codexHome = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");
  try {
    return mcpServerNamesInToml(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return new Set();
  }
}

export function mountedMcpServerName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name}_laterdog`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}_laterdog${i}`;
  return candidate;
}
