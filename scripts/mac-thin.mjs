import { execFile } from "node:child_process";
import { chmod, copyFile, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const LIPO = "/usr/bin/lipo";
const MACH_O_MAGIC = new Set([0xcafebabe, 0xcafebabf, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

export const LIPO_ARCH = { arm64: "arm64", x64: "x86_64" };

export async function isMachO(file) {
  const handle = await open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGIC.has(buffer.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

async function machOArchs(file) {
  const { stdout } = await run(LIPO, ["-archs", file]);
  return stdout.trim().split(/\s+/);
}

export async function writeThinMachO(source, destination, arch) {
  const archs = await machOArchs(source);
  if (!archs.includes(arch)) throw new Error(`${source} has no ${arch} slice: [${archs.join(" ")}]`);
  if (source === destination && archs.length === 1) return;
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.thin`);
  try {
    if (archs.length === 1) await copyFile(source, temporary);
    else await run(LIPO, [source, "-thin", arch, "-output", temporary]);
    await chmod(temporary, (await stat(source)).mode & 0o7777);
    const written = await machOArchs(temporary);
    if (written.join(" ") !== arch) throw new Error(`${destination} would be [${written.join(" ")}], not ${arch}`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
