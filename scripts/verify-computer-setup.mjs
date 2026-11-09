import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ComputerRuns } from '../dist-server/server/laterdog/computer-runs.js';

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'patch-scaling-linux-'));
const computer = join(root, 'computer');
const folder = join(root, 'session-one');
mkdirSync(computer);
mkdirSync(join(folder, 'vendor', 'fixture-package'), { recursive: true });
writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'isolated-setup-smoke', private: true, dependencies: { 'fixture-package': 'file:vendor/fixture-package' } }));
writeFileSync(join(folder, 'vendor', 'fixture-package', 'package.json'), JSON.stringify({ name: 'fixture-package', version: '1.0.0', main: 'index.js' }));
writeFileSync(join(folder, 'vendor', 'fixture-package', 'index.js'), 'module.exports = 42;\n');
const box = {
  async exec(command) {
    try {
      const out = await exec('bash', ['-c', command], { cwd: computer, env: { ...process.env, HOME: computer }, maxBuffer: 8 * 1024 * 1024 });
      return { exitCode: 0, ...out };
    } catch (error) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  },
  async write(path, bytes) { mkdirSync(dirname(join(computer, path)), { recursive: true }); writeFileSync(join(computer, path), bytes); },
  async read(path) { return readFileSync(join(computer, path)); },
};
const runs = new ComputerRuns(join(root, 'state'), { sleep: () => new Promise(resolve => setTimeout(resolve, 100)) });
const lock = await runs.run(box, { botId: 'isolated-dog', folder, command: 'pnpm install --lockfile-only' });
assert.equal(lock.exitCode, 0, lock.output);
assert.ok(existsSync(join(folder, 'pnpm-lock.yaml')));
const install = await runs.run(box, { botId: 'isolated-dog', folder, command: 'pnpm install --offline --frozen-lockfile && node -e "require(\'node:assert/strict\').equal(require(\'fixture-package\'),42)"' });
assert.equal(install.exitCode, 0, install.output);
assert.equal(existsSync(join(folder, 'node_modules')), false);
const copy = join(root, 'session-two');
cpSync(folder, copy, { recursive: true });
const reuse = await runs.run(box, { botId: 'isolated-dog', folder: copy, command: 'node -e "require(\'node:assert/strict\').equal(require(\'fixture-package\'),42)" && mkdir report && echo reused > report/result.txt' });
assert.equal(reuse.exitCode, 0, reuse.output);
assert.match(reuse.note, /Reused the packages/);
assert.equal(readFileSync(join(copy, 'report', 'result.txt'), 'utf8'), 'reused\n');
assert.equal(existsSync(join(copy, 'node_modules')), false);
const changed = join(root, 'session-three');
cpSync(folder, changed, { recursive: true });
writeFileSync(join(changed, 'pnpm-lock.yaml'), readFileSync(join(changed, 'pnpm-lock.yaml'), 'utf8') + '\nchanged: true\n');
const miss = await runs.run(box, { botId: 'isolated-dog', folder: changed, command: 'test ! -e node_modules' });
assert.equal(miss.exitCode, 0, miss.output);
assert.doesNotMatch(miss.note ?? '', /Reused/);
const report = { platform: process.platform, node: process.version, at: new Date().toISOString(), lockfile: lock.exitCode, offlineInstall: install.exitCode, newSessionReuse: reuse.exitCode, reuseNote: reuse.note, changedLockNotReused: miss.exitCode, packagesReturnedToHome: false, broughtBack: reuse.broughtBack };
console.log(JSON.stringify(report, null, 2));
