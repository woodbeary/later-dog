import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { grokInheritedProfile, grokToolScopeProfile } from "../drivers/acp/grok.ts";
import { guestGrokPolicy } from "./guest-grok-policy.ts";

it("keeps the selected account's own native tool restrictions on its computer", async () => {
  const home = await mkdtemp(join(tmpdir(), "ld-grok-policy-"));
  try {
    const config = join(home, ".grok");
    await mkdir(config);
    const original = join(config, "selected.md");
    await writeFile(original, "---\n" + JSON.stringify({ name: "original", description: "private account label", tools: ["read_file", "write"], disallowedTools: ["write"], toolConfig: { tools: [{ id: "GrokBuild:read_file", name_override: "read_file" }, { id: "OpenCode:write", name_override: "write" }] } }) + "\n---\n");
    await writeFile(join(config, "config.toml"), "[agent]\ndefinition = " + JSON.stringify(original));
    const env = { HOME: home, GROK_HOME: config };
    const { policy } = guestGrokPolicy("grok", env, home);
    expect(JSON.stringify(policy)).not.toContain("private account label");
    const guest = join(home, "guest");
    await mkdir(guest);
    const selected = join(guest, "selected-agent.md");
    await writeFile(selected, "---\n" + JSON.stringify(policy) + "\n---\n");
    const carried = grokInheritedProfile("grok", { HOME: guest }, guest, selected);
    const native = grokToolScopeProfile({ allow: ["native:read_file", "native:write"] }, { _meta: { grokShell: true, agentVersion: "1.0.41" } }, carried);
    expect(native.toolConfig.tools).toEqual([{ id: "GrokBuild:read_file", name_override: "read_file" }]);
    expect(native.disallowedTools).toContain("write");
    expect(() => guestGrokPolicy("grok", { ...env, GROK_AGENT: "custom-native-account" }, home)).toThrow(/existing agent profile/);
    await writeFile(original, "---\n" + JSON.stringify({ name: "custom", description: "test", privateSettings: { secret: "fixture" } }) + "\n---\n");
    expect(() => guestGrokPolicy("grok", env, home)).toThrow(/cannot preserve/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
