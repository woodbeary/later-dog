import { readdir, readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
const canonical = 'skills/laterdog';
const targets = ['.agents/skills', '.cursor/skills', '.claude/skills'];
for (const entry of await readdir(canonical, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(canonical, entry.name, 'SKILL.md');
  const skill = await readFile(source, 'utf8');
  for (const target of targets) {
    const directory = join(target, entry.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), skill.replace('{{TOOLS}}', target.startsWith('.cursor') ? 'Use the later.dog MCP server. Tool prefixes depend on the client; discover tools by their names below.' : 'Use the later.dog MCP server. Discover tools by the names below; client-specific prefixes may vary.'));
    try { await cp(join(canonical, entry.name, 'features'), join(directory, 'features'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
console.log('Exported canonical later.dog skills for Codex-compatible agents, Cursor and Claude Code.');
