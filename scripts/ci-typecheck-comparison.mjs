import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const checker = process.argv[2];
if (!['tsc', 'bun', 'tsgo'].includes(checker)) throw new Error('Choose tsc, bun or tsgo');
const output = resolve(process.env.CI_FAST_OUTPUT || '.typecheck-comparison');
mkdirSync(output, { recursive: true });
const command = checker === 'bun' ? 'bun' : checker === 'tsgo' ? process.env.CI_FAST_TSGO : './node_modules/.bin/tsc';
if (!command) throw new Error('CI_FAST_TSGO must name the installed native checker');
const version = spawnSync(command, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) throw version.error || new Error(version.stderr);
const results = [];

function check(label, project) {
  const args = project === 'app' ? ['-b'] : ['-p', 'tsconfig.server.json'];
  if (project === 'app' && checker !== 'bun') args.push('--force');
  args.push('--pretty', 'false');
  if (checker === 'bun') args.unshift('check', '--no-script');
  const start = performance.now();
  const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = (child.stdout || '') + (child.stderr || '') + (child.error?.stack || '');
  const result = { label, project, command, args, code: child.status, signal: child.signal, milliseconds: performance.now() - start, errors: [...text.matchAll(/error TS(\d+)/g)].map((match) => match[1]) };
  writeFileSync(join(output, `${label}-${project}.log`), text);
  console.log(JSON.stringify(result));
  results.push(result);
  return { ...result, text };
}

function phase(label) {
  return ['app', 'server'].map((project) => check(label, project));
}

function controls(label) {
  if (existsSync('src/ci-fast-typecheck-probe.ts') || existsSync('server/ci-fast-typecheck-probe.ts')) throw new Error('A probe path already exists');
  const invalid = 'export const ciFastTypeProbe: number = "type-check-must-fail";\n';
  writeFileSync('src/ci-fast-typecheck-probe.ts', invalid);
  writeFileSync('server/ci-fast-typecheck-probe.ts', invalid);
  try {
    return phase(label).map((result) => ({ ...result, caughtProbe: result.code !== null && result.code !== 0 && /ci-fast-typecheck-probe\.ts[^\n]*TS2322/.test(result.text) }));
  } finally {
    unlinkSync('src/ci-fast-typecheck-probe.ts');
    unlinkSync('server/ci-fast-typecheck-probe.ts');
  }
}

const baseline = phase('original');
const originalControls = controls('original-probe');
let adjusted = null;
let adjustedControls = null;
if (checker !== 'tsc') {
  const config = readFileSync('tsconfig.json', 'utf8');
  const parsed = JSON.parse(config);
  delete parsed.compilerOptions.baseUrl;
  writeFileSync('tsconfig.json', `${JSON.stringify(parsed, null, 2)}\n`);
  try {
    adjusted = phase('without-base-url');
    adjustedControls = controls('without-base-url-probe');
  } finally {
    writeFileSync('tsconfig.json', config);
  }
}
const summary = { checker, version: version.stdout.trim(), node: process.version, head: process.env.GITHUB_SHA, baseline: baseline.map(({ text, ...result }) => result), originalControls: originalControls.map(({ text, ...result }) => result), adjusted: adjusted?.map(({ text, ...result }) => result), adjustedControls: adjustedControls?.map(({ text, ...result }) => result) };
writeFileSync(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const originalPassed = baseline.every((result) => result.code === 0) && originalControls.every((result) => result.caughtProbe);
if (!originalPassed) process.exitCode = 1;
