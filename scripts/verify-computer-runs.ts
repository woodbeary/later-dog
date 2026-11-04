import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ComputersClient } from "../server/laterdog/cloud-computers.ts";
import { ComputerRuns, type RunBox } from "../server/laterdog/computer-runs.ts";

const api = process.env.LATERDOG_COMPUTERS_API ?? "https://cloud.later.dog/v1";
const keyFile = process.env.LATERDOG_COMPUTERS_KEY_FILE ?? join(homedir(), ".laterdog", "computers-key");
const client = new ComputersClient({ api, keyFile, source: "environment" });
const name = `runs-check-${Date.now().toString(36)}`;
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

async function running(id: string) {
  for (let i = 0; i < 120; i++) {
    const found = await client.get(id);
    if (found?.state === "running") return;
    if (found && found.state !== "starting") await client.wake(id).catch(() => undefined);
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error("computer did not start");
}

const computer = await client.create({ name, size: "standard" }, `ldc-create-${name}`);
log(`created ${computer.id} (${name})`);
try {
  await running(computer.id);
  log("running");
  const box: RunBox = {
    exec: async (command, timeoutMs) => { const out = await client.exec(computer.id, { command, timeoutMs }); return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr }; },
    write: (path, bytes) => client.writeFile(computer.id, path, bytes),
    read: (path) => client.readFile(computer.id, path),
  };
  const root = mkdtempSync(join(tmpdir(), "runs-check-"));
  const folder = join(root, "app");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "runs-check", private: true, type: "module", scripts: { build: "node build.mjs", test: "node --test" }, dependencies: { "left-pad": "1.3.0" } }, null, 2));
  writeFileSync(join(folder, "build.mjs"), "import { mkdirSync, writeFileSync } from 'node:fs';\nimport pad from 'left-pad';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/out.txt', pad('built', 10));\nmkdirSync('report', { recursive: true });\nwriteFileSync('report/summary.txt', 'build ok ' + process.version + '\\n');\n");
  writeFileSync(join(folder, "src/math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.strictEqual(1 + 1, 2));\n");
  writeFileSync(join(folder, "big.bin"), Buffer.alloc(30 * 1024 * 1024, 7));
  const runs = new ComputerRuns(join(root, "state"));
  const t0 = Date.now();
  const first = await runs.run(box, { botId: "check", folder, command: "pnpm install && pnpm build && pnpm test 2>&1 | tail -5" });
  log(`first run ${first.state} exit ${first.exitCode} in ${Math.round((Date.now() - t0) / 1000)}s, sent ${first.sentFiles} files ${Math.round(first.sentBytes / 1024)} KB, back ${JSON.stringify(first.broughtBack)}`);
  log(`output tail: ${first.output.trim().split("\n").slice(-6).join(" | ")}`);
  if (first.exitCode !== 0) throw new Error("first run failed");
  if (!existsSync(join(folder, "report/summary.txt"))) throw new Error("report not brought back");
  if (existsSync(join(folder, "node_modules")) || existsSync(join(folder, "dist"))) throw new Error("build output came back");
  log(`report here: ${readFileSync(join(folder, "report/summary.txt"), "utf8").trim()}`);
  writeFileSync(join(folder, "src/more.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('more', () => assert.ok(true));\n");
  const t1 = Date.now();
  const second = await runs.run(box, { botId: "check", folder, command: "ls node_modules | head -3 && pnpm test 2>&1 | grep -E 'pass|fail'" });
  log(`second run ${second.state} exit ${second.exitCode} in ${Math.round((Date.now() - t1) / 1000)}s, sent ${second.sentFiles} files; output: ${second.output.trim().split("\n").join(" | ")}`);
  if (second.exitCode !== 0) throw new Error("second run failed");
  if (second.sentFiles !== 1) throw new Error(`second run sent ${second.sentFiles} files, expected 1`);
  const started = await runs.start(box, { botId: "check", folder, command: "sleep 150; echo late > late.txt" });
  log(`long run ${started.id} started; checking it survives the exec that started it`);
  await new Promise((done) => setTimeout(done, 20_000));
  const mid = await runs.poll(box, started);
  log(`after 20s: done=${mid.done}`);
  const third = await runs.finish(box, started);
  log(`long run ${third.state} exit ${third.exitCode}, back ${JSON.stringify(third.broughtBack)}`);
  if (third.state !== "finished" || !existsSync(join(folder, "late.txt"))) throw new Error("long run did not finish and come back");
  log("ALL CHECKS PASSED");
} finally {
  const gone = await client.remove(computer.id).catch((error) => `delete failed: ${error.message}`);
  log(`deleted computer: ${gone}`);
}
