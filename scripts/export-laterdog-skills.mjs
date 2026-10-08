import { readdir, readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
const canonical = 'skills/laterdog';
// Codex reads .agents/skills, Cursor .cursor/skills, Claude Code .claude/skills; `skills/` holds the plugin-style copies.
const targets = ['.agents/skills', '.cursor/skills', '.claude/skills', 'skills'];
for (const entry of await readdir(canonical, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(canonical, entry.name, 'SKILL.md');
  const skill = await readFile(source, 'utf8');
  for (const target of targets) {
    const directory = join(target, target === 'skills' ? `laterdog-${entry.name}` : entry.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), skill.replace('{{TOOLS}}', target.startsWith('.cursor') ? 'Use the later.dog MCP server. Tool prefixes depend on the client; discover tools by their names below.' : 'Use the later.dog MCP server. Discover tools by the names below; client-specific prefixes may vary.'));
    if (target === 'skills') await writeFile(join(directory,'manifest.json'),JSON.stringify({id:`laterdog-${entry.name}`,name:`later.dog ${entry.name.replaceAll('-',' ')}`,version:'0.1.0',description:skill.match(/^description: "(.+)"$/m)?.[1] ?? entry.name,defaultEnabled:true,triggerTerms:entry.name === 'create-verification-skill' ? ['laterdog verification skill','laterdog-create-verification-skill'] : [entry.name.replaceAll('-',' '),entry.name,...(entry.name === 'orchestrate-cloud-work' ? ['delegate cloud','cloud jobs'] : [])],requiredCapabilities:entry.name === 'create-verification-skill' ? ['skillAuthoring'] : []},null,2)+'\n');
    try { await cp(join(canonical, entry.name, 'features'), join(directory, 'features'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
console.log('Exported canonical later.dog skills for Codex-compatible agents, Cursor and Claude Code.');
