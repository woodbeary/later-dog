import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { leasePort, leasePortBlock, PORT_LEASE_CEILING, PORT_LEASE_FLOOR, releasePortLeases, tryLeasePorts } from "./ports.ts";

const PORTS_MODULE = pathToFileURL(join(import.meta.dirname, "ports.ts")).href;

let leaseDir: string;
let inheritedLeaseDir: string | undefined;

beforeEach(() => {
  inheritedLeaseDir = process.env.LATERDOG_PORT_LEASE_DIR;
  leaseDir = mkdtempSync(join(tmpdir(), "laterdog-port-lease-test-"));
  process.env.LATERDOG_PORT_LEASE_DIR = leaseDir;
});

afterEach(() => {
  releasePortLeases();
  if (inheritedLeaseDir === undefined) delete process.env.LATERDOG_PORT_LEASE_DIR;
  else process.env.LATERDOG_PORT_LEASE_DIR = inheritedLeaseDir;
  rmSync(leaseDir, { recursive: true, force: true });
});

const leaseFiles = () => readdirSync(leaseDir).filter((name) => name.endsWith(".lease")).sort();

interface Leaser {
  answer: Promise<string>;
  exited: Promise<void>;
  finish(): void;
}

function startLeaser(script: string): Leaser {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import * as ports from ${JSON.stringify(PORTS_MODULE)};\n${script}\nprocess.stdin.resume();\nprocess.stdin.once("end", () => process.exit(0));`], {
    env: { ...process.env, LATERDOG_PORT_LEASE_DIR: leaseDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk) => (err += String(chunk)));
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`leaser exited ${code}: ${err}`))));
  });
  const answer = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.endsWith("\n")) resolve(out.trim());
    });
    exited.then(() => reject(new Error(`leaser ended without answering: ${err}`)), reject);
  });
  return { answer, exited, finish: () => child.stdin.end() };
}

async function whileAllHold(scripts: string[]): Promise<string[]> {
  const leasers = scripts.map(startLeaser);
  try {
    return await Promise.all(leasers.map((leaser) => leaser.answer));
  } finally {
    for (const leaser of leasers) leaser.finish();
    await Promise.allSettled(leasers.map((leaser) => leaser.exited));
  }
}

describe("port leases", () => {
  it("hands out a block inside the leased range, below the ephemeral range, with one lease file per port", async () => {
    const base = await leasePortBlock([0, 1, 3]);
    expect(base).toBeGreaterThanOrEqual(PORT_LEASE_FLOOR);
    expect(base + 3).toBeLessThan(PORT_LEASE_CEILING);
    expect(leaseFiles()).toEqual([base, base + 1, base + 3].map((port) => `${port}.lease`).sort());
  });

  it("gives the same port to only one of many processes asking for it at once", async () => {
    const wanted = await leasePortBlock([0, 1]);
    releasePortLeases([wanted, wanted + 1]);
    const answers = await whileAllHold(Array.from({ length: 8 }, () =>
      `const won = await ports.tryLeasePorts([${wanted}, ${wanted + 1}]);\nconsole.log(won ? "won" : "lost");`,
    ));
    expect(answers.filter((answer) => answer === "won")).toHaveLength(1);
    expect(answers.filter((answer) => answer === "lost")).toHaveLength(7);
  });

  it("never hands overlapping blocks to processes leasing at the same time", async () => {
    const blocks = await whileAllHold(Array.from({ length: 6 }, () =>
      `const bases = [];\nfor (let i = 0; i < 40; i++) bases.push(await ports.leasePortBlock([0, 1]));\nconsole.log(JSON.stringify(bases));`,
    ));
    const ports = blocks.flatMap((line) => (JSON.parse(line) as number[]).flatMap((base) => [base, base + 1]));
    expect(ports).toHaveLength(6 * 40 * 2);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("refuses a port another live process holds and frees it when that process exits", async () => {
    const holder = startLeaser("console.log(await ports.leasePort());");
    const port = Number(await holder.answer);
    expect(await tryLeasePorts([port])).toBe(false);
    holder.finish();
    await holder.exited;
    expect(leaseFiles()).toEqual([]);
    expect(await tryLeasePorts([port])).toBe(true);
  });

  it("takes over a lease whose process died without releasing it", async () => {
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout.trim());
    const port = await leasePort();
    releasePortLeases([port]);
    writeFileSync(join(leaseDir, `${port}.lease`), `${deadPid} abandoned\n`);
    expect(await tryLeasePorts([port])).toBe(true);
  });

  it("keeps a lease whose holder is still alive, even when the file was left by another checkout", async () => {
    const port = await leasePort();
    releasePortLeases([port]);
    writeFileSync(join(leaseDir, `${port}.lease`), `${process.ppid} other-checkout\n`);
    expect(await tryLeasePorts([port])).toBe(false);
    expect(existsSync(join(leaseDir, `${port}.lease`))).toBe(true);
  });

  it("does not lease a port something already listens on, and leaves no lease behind for it", async () => {
    const server = createServer();
    const port = await leasePort();
    releasePortLeases([port]);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      expect(await tryLeasePorts([port])).toBe(false);
      expect(leaseFiles()).toEqual([]);
    } finally {
      await new Promise((settle) => server.close(settle));
    }
  });

  it("releases only what it is asked to, and everything this file holds at the end", async () => {
    const first = await leasePort();
    const second = await leasePort();
    releasePortLeases([first]);
    expect(leaseFiles()).toEqual([`${second}.lease`]);
    releasePortLeases();
    expect(leaseFiles()).toEqual([]);
  });
});
