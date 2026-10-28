import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executeSharedOperation } from "./shared-computer-access.mjs";
import { createCommandRunner, createLoginEnvironment, parseLoginEnvironment } from "./mac-commands.mjs";
import { searchArguments } from "./mac-search.mjs";

async function fixture(t, { write = true, terminal = true } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "laterdog-mac-tools-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = { id: randomUUID(), name: "Fixture", path: dir, write };
  const grant = { enabled: true, folders: [folder], terminal, computer: false };
  const commands = createCommandRunner({ environment: async () => ({ PATH: process.env.PATH, HOME: dir, LANG: "en_US.UTF-8" }) });
  t.after(() => commands.stopAll());
  const run = async (operation, signal = new AbortController().signal) =>
    JSON.parse((await executeSharedOperation(grant, { folder_id: folder.id, ...operation }, signal, undefined, { commands, home: dir })).content[0].text);
  return { dir, folder, grant, run, commands };
}

test("a command that finishes in time answers at once with its output and exit code", async t => {
  const { run } = await fixture(t);
  const done = await run({ action: "run_command", command: "echo hello; exit 3", wait_seconds: 10 });
  assert.equal(done.running, false);
  assert.equal(done.exitCode, 3);
  assert.equal(done.output, "hello\n");
});

test("a long command keeps running in the background and the dog checks back for the rest", async t => {
  const { run } = await fixture(t);
  const started = await run({ action: "run_command", command: "echo first; sleep 2; echo second", wait_seconds: 1 });
  assert.equal(started.running, true);
  assert.match(started.command_id, /^[0-9a-f-]{36}$/);
  assert.equal(started.output, "first\n");
  const finished = await run({ action: "command_output", command_id: started.command_id, wait_seconds: 10 });
  assert.equal(finished.running, false);
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.output, "second\n", "only the output the dog hasn't seen yet");
  const again = await run({ action: "command_output", command_id: started.command_id, wait_seconds: 0 });
  assert.equal(again.output, "");
});

test("the dog can type into a running command and close its input", async t => {
  const { run } = await fixture(t);
  const started = await run({ action: "run_command", command: "read line; echo got:$line; cat", wait_seconds: 0 });
  assert.equal(started.running, true);
  await run({ action: "command_input", command_id: started.command_id, input: "hello\n" });
  await run({ action: "command_input", command_id: started.command_id, input: "more\n", close_input: true });
  const finished = await run({ action: "command_output", command_id: started.command_id, wait_seconds: 10 });
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.output, "got:hello\nmore\n");
});

test("command_stop ends a running command and its children", async t => {
  const { run, dir } = await fixture(t);
  const marker = path.join(dir, "late");
  const started = await run({ action: "run_command", command: `sleep 30; touch ${JSON.stringify(marker)}`, wait_seconds: 0 });
  const stopped = await run({ action: "command_stop", command_id: started.command_id });
  assert.equal(stopped.running, false);
  assert.equal(stopped.signal, "SIGTERM");
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await assert.rejects(run({ action: "command_output", command_id: randomUUID() }), /No such command/);
});

test("ending the dog's turn stops a command it was still waiting on", async t => {
  const { run, dir } = await fixture(t);
  const marker = path.join(dir, "late");
  const turn = new AbortController();
  const pending = run({ action: "run_command", command: `sleep 2; touch ${JSON.stringify(marker)}`, wait_seconds: 10 }, turn.signal);
  setTimeout(() => turn.abort(), 200);
  await assert.rejects(pending, /requesting turn ended/);
  await new Promise(resolve => setTimeout(resolve, 2500));
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("cwd picks the folder a command runs in, relative to the lent folder or ~", async t => {
  const { run, dir } = await fixture(t);
  await mkdir(path.join(dir, "code", "app"), { recursive: true });
  assert.equal((await run({ action: "run_command", command: "pwd -P" })).output.trim(), dir);
  assert.equal((await run({ action: "run_command", command: "pwd -P", cwd: "code/app" })).output.trim(), path.join(dir, "code", "app"));
  assert.equal((await run({ action: "run_command", command: "pwd -P", cwd: "~/code" })).output.trim(), path.join(dir, "code"));
  await assert.rejects(run({ action: "run_command", command: "pwd", cwd: "nowhere" }), /cwd folder doesn't exist/);
  await writeFile(path.join(dir, "file.txt"), "x");
  await assert.rejects(run({ action: "run_command", command: "pwd", cwd: "file.txt" }), /names a file, not a folder/);
});

test("on a home grant, ~ in cwd is the lent home folder", async t => {
  const { dir, folder } = await fixture(t);
  await mkdir(path.join(dir, "proj"));
  const grant = { enabled: true, home: true, folders: [{ ...folder, name: "Home" }], terminal: true, computer: false };
  const commands = createCommandRunner({ environment: async () => ({ PATH: process.env.PATH }) });
  t.after(() => commands.stopAll());
  const ran = await executeSharedOperation(grant, { folder_id: folder.id, action: "run_command", command: "pwd -P", cwd: "~/proj" }, new AbortController().signal, undefined, { commands, platform: "linux" });
  assert.equal(JSON.parse(ran.content[0].text).output.trim(), path.join(dir, "proj"));
});

test("command tools need the terminal grant", async t => {
  const { run } = await fixture(t, { terminal: false });
  for (const action of ["run_command", "command_output", "command_input", "command_stop"]) {
    await assert.rejects(run({ action, command: "echo x", command_id: randomUUID() }), /Terminal access/);
  }
});

test("only the newest output is kept when a command prints more than the Mac holds", async t => {
  const runner = createCommandRunner({ environment: async () => ({ PATH: process.env.PATH }), keepBytes: 1000 });
  t.after(() => runner.stopAll());
  const done = await runner.start({ command: "for i in $(seq 1 400); do echo line-$i; done", cwd: tmpdir(), waitSeconds: 10 });
  assert.equal(done.running, false);
  assert.ok(done.output.endsWith("line-400\n"));
  assert.ok(done.skipped_bytes > 0);
  assert.ok(Buffer.byteLength(done.output) <= 1100);
});

test("edit_file swaps exact text, refuses missing or ambiguous text, and can replace all", async t => {
  const { run, dir } = await fixture(t);
  await writeFile(path.join(dir, "app.ts"), "const a = 1;\nconst b = 1;\nexport { a, b };\n");
  await assert.rejects(run({ action: "edit_file", path: "app.ts", old_text: "const c", new_text: "x" }), /wasn't found/);
  await assert.rejects(run({ action: "edit_file", path: "app.ts", old_text: " = 1;", new_text: " = 2;" }), /appears 2 times/);
  const one = await run({ action: "edit_file", path: "app.ts", old_text: "const a = 1;", new_text: "const a = $& 2;" });
  assert.equal(one.replacements, 1);
  assert.equal(await readFile(path.join(dir, "app.ts"), "utf8"), "const a = $& 2;\nconst b = 1;\nexport { a, b };\n");
  const all = await run({ action: "edit_file", path: "app.ts", old_text: "const", new_text: "let", replace_all: true });
  assert.equal(all.replacements, 2);
  assert.match(all.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(dir, "app.ts"), "utf8"), "let a = $& 2;\nlet b = 1;\nexport { a, b };\n");
});

test("edit_file changes big text files the 256 KiB write limit can't, but never binaries or .git", async t => {
  const { run, dir } = await fixture(t);
  const big = `${"x".repeat(600 * 1024)}\nneedle\n`;
  await writeFile(path.join(dir, "big.txt"), big);
  await run({ action: "edit_file", path: "big.txt", old_text: "needle", new_text: "found" });
  assert.ok((await readFile(path.join(dir, "big.txt"), "utf8")).endsWith("\nfound\n"));
  await writeFile(path.join(dir, "image.bin"), Buffer.from([0, 1, 2, 104, 105]));
  await assert.rejects(run({ action: "edit_file", path: "image.bin", old_text: "hi", new_text: "yo" }), /binary/);
  await mkdir(path.join(dir, "repo", ".git"), { recursive: true });
  await writeFile(path.join(dir, "repo", ".git", "config"), "[core]\n");
  await assert.rejects(run({ action: "edit_file", path: "repo/.git/config", old_text: "core", new_text: "hook" }), /\.git/);
});

test("delete_file removes a file or an empty folder, never a full folder or the lent folder itself", async t => {
  const { run, dir } = await fixture(t);
  await writeFile(path.join(dir, "old.txt"), "bye");
  assert.deepEqual(await run({ action: "delete_file", path: "old.txt" }), { deleted: true, kind: "file" });
  await assert.rejects(stat(path.join(dir, "old.txt")), { code: "ENOENT" });
  await mkdir(path.join(dir, "empty"));
  assert.deepEqual(await run({ action: "delete_file", path: "empty" }), { deleted: true, kind: "folder" });
  await mkdir(path.join(dir, "full"));
  await writeFile(path.join(dir, "full", "keep.txt"), "keep");
  await assert.rejects(run({ action: "delete_file", path: "full" }), /isn't empty/);
  await assert.rejects(run({ action: "delete_file", path: "" }), /inside the shared folder/);
});

test("search_files finds text by pattern and glob, skipping node_modules and .git", async t => {
  const { run, dir } = await fixture(t);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "node_modules", "lib"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const Needle = 1;\n");
  await writeFile(path.join(dir, "src", "b.md"), "needle in the docs\n");
  await writeFile(path.join(dir, "node_modules", "lib", "c.ts"), "needle in a dependency\n");
  const all = await run({ action: "search_files", path: "", pattern: "needle", ignore_case: true });
  assert.deepEqual(all.matches.sort(), ["src/a.ts:1:export const Needle = 1;", "src/b.md:1:needle in the docs"]);
  const typed = await run({ action: "search_files", path: "src", pattern: "needle", glob: "*.ts", ignore_case: true });
  assert.deepEqual(typed.matches, ["a.ts:1:export const Needle = 1;"]);
  assert.deepEqual((await run({ action: "search_files", path: "src", pattern: "needle" })).matches, ["b.md:1:needle in the docs"]);
  const capped = await run({ action: "search_files", path: "", pattern: "e", max_results: 1 });
  assert.equal(capped.matches.length, 1);
  assert.equal(capped.truncated, true);
});

test("search_files refuses a folder that holds the person's keys", async t => {
  const { dir, folder } = await fixture(t);
  await mkdir(path.join(dir, ".ssh"));
  await writeFile(path.join(dir, ".ssh", "id_ed25519"), "secret needle");
  const grant = { enabled: true, folders: [folder], terminal: false, computer: false, protectedPaths: [path.join(dir, ".ssh")] };
  await assert.rejects(
    executeSharedOperation(grant, { folder_id: folder.id, action: "search_files", path: "", pattern: "needle" }, new AbortController().signal),
    /holds your keys/,
  );
});

test("search arguments never pass the pattern to a shell and skip heavy folders", () => {
  const rg = searchArguments("rg", { pattern: "$(rm -rf ~)", glob: "*.ts", ignoreCase: true, target: "." });
  assert.deepEqual(rg.slice(-4), ["-e", "$(rm -rf ~)", "--", "."]);
  assert.ok(rg.includes("!node_modules/"));
  const grep = searchArguments("grep", { pattern: "x", target: "." });
  assert.ok(grep.includes("--exclude-dir=node_modules"));
});

test("the login environment is read from the person's shell, ignoring what it prints first", () => {
  const env = parseLoginEnvironment(`Last login: today\n__LATERDOG_LOGIN_ENV__\0PATH=/Users/me/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin\0HOME=/Users/me\0PWD=/tmp\0SHLVL=2\0WEIRD KEY=x\0`);
  assert.deepEqual(env, { PATH: "/Users/me/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin", HOME: "/Users/me" });
  assert.equal(parseLoginEnvironment("no marker here"), null);
  assert.equal(parseLoginEnvironment("__LATERDOG_LOGIN_ENV__\0HOME=/x\0"), null);
});

test("a shell that hangs falls back to a plain environment with Homebrew on the PATH", async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.pid = 999_999_999;
    child.stdout = new EventEmitter();
    child.kill = () => child.emit("close", null, "SIGKILL");
    return child;
  };
  const environment = createLoginEnvironment({ source: { SHELL: "/bin/zsh", USER: "me" }, home: "/Users/me", spawnImpl: fakeSpawn, timeoutMs: 50 });
  const env = await environment();
  assert.equal(env.HOME, "/Users/me");
  assert.match(env.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(await environment(), env, "resolved once per app session");
});
