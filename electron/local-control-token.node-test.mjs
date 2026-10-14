import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCAL_CONTROL_TOKEN_FILE, localControlTokenPath, removeLocalControlToken, startLocalControlToken, writeLocalControlToken } from "./local-control-token.mjs";
import { localControlTokenPath as scriptPath, readLocalControlToken } from "../scripts/local-control-token.ts";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "laterdog-local-control-"));

test("writes a fresh random token to a private file in the app's own folder", (t) => {
  const userData = temp();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const first = writeLocalControlToken(userData);
  assert.equal(first.file, path.join(userData, LOCAL_CONTROL_TOKEN_FILE));
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.readFileSync(first.file, "utf8"), `${first.token}\n`);
  if (process.platform !== "win32") assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  const second = writeLocalControlToken(userData);
  assert.notEqual(second.token, first.token);
  assert.equal(fs.readFileSync(second.file, "utf8"), `${second.token}\n`);
  assert.deepEqual(fs.readdirSync(userData), [LOCAL_CONTROL_TOKEN_FILE]);
});

test("replaces a file that was left readable by others with a private one", (t) => {
  const userData = temp();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const file = localControlTokenPath(userData);
  fs.writeFileSync(file, "old", { mode: 0o644 });
  writeLocalControlToken(userData);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("is read by the scripts at the same path on the same machine", (t) => {
  const userData = temp();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { token, file } = writeLocalControlToken(userData);
  assert.equal(readLocalControlToken(file), token);
  const home = temp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const expected = scriptPath({}, "linux", home);
  assert.equal(path.basename(expected), LOCAL_CONTROL_TOKEN_FILE);
  assert.equal(path.basename(path.dirname(expected)), "later.dog");
});

test("removes only its own token at quit", (t) => {
  const userData = temp();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { token, file } = writeLocalControlToken(userData);
  removeLocalControlToken(file, "someone-elses-token");
  assert.equal(fs.existsSync(file), true);
  removeLocalControlToken(file, token);
  assert.equal(fs.existsSync(file), false);
  removeLocalControlToken(file, token);
});

test("rejects a malformed token and writes nothing", (t) => {
  const userData = temp();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  assert.throws(() => writeLocalControlToken(userData, { generate: () => "short" }), /invalid local control token/);
  assert.deepEqual(fs.readdirSync(userData), []);
});

test("keeps the app starting when the file cannot be written, and says what it costs", (t) => {
  const userData = temp();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const blocked = path.join(userData, "not-a-folder");
  fs.writeFileSync(blocked, "x");
  const lines = [];
  assert.equal(startLocalControlToken(blocked, (line) => lines.push(line)), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /need a paired session/);
  assert.doesNotMatch(lines[0], /[A-Za-z0-9_-]{43}/);
});
