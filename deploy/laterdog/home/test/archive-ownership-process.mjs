import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chown, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileIsUnopened } from "../runtime/archive-ownership.mjs";

if (process.platform !== "linux" || process.getuid() !== 0) throw new Error("run only in the disposable root container");
const root = await mkdtemp("/tmp/archive-owner-");
const file = root + "/log";
let child;
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
  console.log("root/dog descriptor scan: held file refused; closed file eligible with the dog process still alive and no added capabilities");
} finally {
  if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  await rm(root, { recursive: true });
}
