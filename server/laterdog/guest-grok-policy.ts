import { basename } from "node:path";
import { grokInheritedProfile } from "../drivers/acp/grok.ts";
import { splitCliString, userHome } from "../env-path.ts";

function unsupported(): never {
  throw new Error("The selected Grok account has native profile settings its computer cannot preserve safely.");
}

export function guestGrokPolicy(cli: string, environment: Record<string, string>, cwd?: string) {
  const args = splitCliString(cli);
  const binary = args[0];
  if (!binary || basename(binary) !== "grok" || !(args.length === 1 || (args.length === 2 && args[1]!.startsWith("--agent-profile=")) || (args.length === 3 && args[1] === "--agent-profile"))) unsupported();
  const env = { ...process.env, ...environment };
  if (env.GROK_SANDBOX) unsupported();
  const profile = grokInheritedProfile(cli, env, cwd || userHome(env));
  if (!profile) return { binary };
  const fields = new Set(["name", "description", "toolConfig", "tools", "disallowedTools", "discoverSkills", "injectDefaultTools", "model"]);
  const identifier = (value: unknown) => typeof value === "string" && /^[\w.:-]{1,256}$/.test(value);
  if (Object.keys(profile).some(key => !fields.has(key)) || Object.keys(profile.toolConfig).some(key => key !== "tools")
    || profile.toolConfig.tools.some(tool => Object.keys(tool).some(key => key !== "id" && key !== "name_override") || !identifier(tool.id) || (tool.name_override !== undefined && !identifier(tool.name_override)))
    || [profile.tools, profile.disallowedTools].some(list => list?.some(value => !identifier(value)))
    || [profile.injectDefaultTools, profile.discoverSkills].some(value => value !== undefined && typeof value !== "boolean")
    || (profile.model !== undefined && !identifier(profile.model))) unsupported();
  return { binary, policy: { ...profile, name: "laterdog-account-tools", description: "Selected account tools" } };
}
