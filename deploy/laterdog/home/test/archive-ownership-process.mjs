import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chown, chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { launcherOwnsNoFile } from "../runtime/archive-launcher.mjs";
import { fileIsUnopened } from "../runtime/archive-ownership.mjs";

if (process.platform !== "linux" || process.getuid() !== 0) throw new Error("run only in the disposable root container");
const root = await mkdtemp("/tmp/archive-owner-");
const file = root + "/log";
let child;
let launcher;
try {
  await writeFile(file, "saved history");
  await chown(root, 1000, 1000);
  await chown(file, 1000, 1000);
  await chmod(root, 0o700);
  child = spawn(process.execPath, ["-e",
    'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");process.stdout.write("ready");process.stdin.once("data",()=>{fs.closeSync(fd);process.stdout.write("closed");});setInterval(()=>{},1000);', file],
  { uid: 1000, gid: 1000, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  await once(child.stdout, "data");
  assert.equal(await fileIsUnopened(file, { asOwner: { uid: 1000, gid: 1000 } }), false);
  child.stdin.write("close");
  await once(child.stdout, "data");
  assert.equal(await fileIsUnopened(file), false);
  assert.equal(await fileIsUnopened(file, { asOwner: { uid: 1000, gid: 1000 } }), true);
  launcher = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    'import fs from "node:fs";import{listenForArchiveOwnership}from"/archive-descriptors.ts";const fd=fs.openSync(process.argv[1],"r");process.seteuid(1000);process.seteuid(0);listenForArchiveOwnership();process.on("message",value=>{if(value.type==="fixture.close"){fs.closeSync(fd);process.send({type:"fixture.closed"});}});process.send({type:"fixture.ready"});setInterval(()=>{},1000);', file],
  { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  await once(launcher, "message");
  const target = await stat(file);
  assert.equal(await launcherOwnsNoFile(launcher, target), false);
  launcher.send({ type: "fixture.close" });
  await once(launcher, "message");
  assert.equal(await fileIsUnopened(file, { asOwner: { uid: 1000, gid: 1000 } }), false);
  assert.equal(await launcherOwnsNoFile(launcher, target), true);
  assert.equal(await fileIsUnopened(file, { asOwner: { uid: 1000, gid: 1000 }, launcherPid: launcher.pid }), true);
  console.log("protected launcher IPC: held log refused, closed log permitted without opening its private descriptor table");
  console.log("root/dog descriptor scan: held file refused; closed file eligible with the dog process still alive and no added capabilities");
} finally {
  if (launcher?.exitCode === null) { launcher.kill("SIGTERM"); await once(launcher, "exit"); }
  if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  await rm(root, { recursive: true });
}
