import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const suffix = randomUUID();
const container = `laterdog-smoke-${suffix}`;
const volume = `${container}-state`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function start() {
  docker(['run', '-d', '--name', container, '-p', '127.0.0.1::9010', '-v', `${volume}:/var/lib/laterdog`, 'laterdog-supervisor:smoke']);
  const port = docker(['port', container, '9010/tcp']).split(':').at(-1);
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${origin}/v1/workspace`);
      if (response.status === 401) return origin;
    } catch { /* Wait for the container HTTP listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Container did not start its authenticated supervisor');
}
try {
  let origin = await start();
  const token = docker(['exec', container, 'cat', '/var/lib/laterdog/access-token']);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const repository = { slug: 'fixture/laterdog', environmentId: 'fixture-only', generation: 'unqualified', baseRef: 'main', publish: false, merge: false };
  const saved = await fetch(`${origin}/v1/repositories`, { method: 'POST', headers, body: JSON.stringify(repository) });
  assert.equal(saved.status, 200);
  docker(['stop', '-t', '20', container]);
  docker(['rm', container]);
  origin = await start();
  assert.equal(docker(['exec', container, 'cat', '/var/lib/laterdog/access-token']), token);
  const response = await fetch(`${origin}/v1/workspace`, { headers });
  assert.equal(response.status, 200);
  const workspace = await response.json();
  assert.ok(workspace.repositories.some((repo) => repo.slug === repository.slug));
  assert.equal(workspace.jobs.length, 0);
  console.log('Container starts without provider credentials; authentication and SQLite repository state survive recreation. No cloud tasks submitted.');
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
}
