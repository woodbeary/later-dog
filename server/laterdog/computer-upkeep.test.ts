import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerUpkeepScript, readUpkeepReport, UPKEEP_LIMITS, type UpkeepPlaces } from "./computer-upkeep.ts";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const HOUR_S = 60 * 60;
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "computer-upkeep-"));
  roots.push(root);
  const home = join(root, "home");
  const temp = join(root, "tmp");
  const cache = join(root, "cache");
  const bin = join(root, "bin");
  for (const dir of [home, temp, cache, bin, join(home, "Downloads"), join(home, ".config/chromium/Crash Reports/completed"), join(cache, "Default/Cache/Cache_Data")]) mkdirSync(dir, { recursive: true });
  const places: UpkeepPlaces = { home: quote(home), temp: quote(temp), cache: quote(cache) };
  const file = (path: string, ageHours: number, bytes = 1024) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
    const when = Date.now() / 1000 - ageHours * HOUR_S;
    utimesSync(path, when, when);
    return path;
  };
  const run = (script: string) => spawnSync("bash", ["-c", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LATERDOG_PAGE_CDP_PORT: "1" }, encoding: "utf8", timeout: 30_000,
  });
  return { root, home, temp, cache, bin, places, file, run };
}

describe("keeping a cloud computer lean after a dog's turn", () => {
  it("removes old downloads, stale partial downloads, old temporary files and crash reports, and keeps recent ones", () => {
    const box = sandbox();
    const oldDownload = box.file(join(box.home, "Downloads/report.pdf"), 30);
    const newDownload = box.file(join(box.home, "Downloads/today.pdf"), 1);
    const stalePartial = box.file(join(box.home, "Downloads/movie.mp4.crdownload"), 2);
    const livePartial = box.file(join(box.home, "Downloads/big.zip.crdownload"), 0.1);
    const oldFolder = join(box.home, "Downloads/unzipped");
    mkdirSync(oldFolder);
    utimesSync(oldFolder, Date.now() / 1000 - 30 * HOUR_S, Date.now() / 1000 - 30 * HOUR_S);
    const oldTemp = box.file(join(box.temp, "build-123/out.log"), 30);
    const newTemp = box.file(join(box.temp, "session.sock.txt"), 1);
    const oldReport = box.file(join(box.home, ".config/chromium/Crash Reports/completed/dump.dmp"), 30);
    const ran = box.run(computerUpkeepScript(UPKEEP_LIMITS, box.places));
    expect(ran.status, ran.stderr).toBe(0);
    expect([oldDownload, stalePartial, oldFolder, oldTemp, oldReport].filter(existsSync)).toEqual([]);
    expect([newDownload, livePartial, newTemp].every(existsSync)).toBe(true);
    const report = readUpkeepReport(ran.stdout);
    expect(report?.stopped).toBe(0);
    expect(report?.freedBytes).toBeGreaterThan(0);
  });

  it("empties the browser's cache folders once they pass the cap, and leaves them under it", () => {
    const box = sandbox();
    const cached = box.file(join(box.cache, "Default/Cache/Cache_Data/entry"), 0, 3 * 1024 * 1024);
    const code = box.file(join(box.cache, "Default/Code Cache/js/entry"), 0, 1024 * 1024);
    const kept = box.file(join(box.cache, "Default/Preferences-like"), 0, 1024);
    expect(box.run(computerUpkeepScript({ ...UPKEEP_LIMITS, cacheBytes: 16 * 1024 * 1024 }, box.places)).status).toBe(0);
    expect([cached, code, kept].every(existsSync)).toBe(true);
    const ran = box.run(computerUpkeepScript({ ...UPKEEP_LIMITS, cacheBytes: 2 * 1024 * 1024 }, box.places));
    expect(ran.status, ran.stderr).toBe(0);
    expect([cached, code].filter(existsSync)).toEqual([]);
    expect(existsSync(kept)).toBe(true);
    expect(readUpkeepReport(ran.stdout)!.freedBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
  });

  it("stops a process that has spun a CPU for half an hour, never the desktop, the browser or one still young or quiet", async () => {
    const box = sandbox();
    const start = () => {
      const child = spawn("sleep", ["60"], { stdio: "ignore" });
      children.push(child);
      return child;
    };
    const [spinner, browser, young, quiet] = [start(), start(), start(), start()];
    const ps = [
      `${spinner.pid} ${45 * 60} 99.5 node`,
      `${browser.pid} ${45 * 60} 99.5 chromium`,
      `${young.pid} 120 99.5 python3`,
      `${quiet.pid} ${45 * 60} 3.0 node`,
    ].join("\n");
    writeFileSync(join(box.bin, "ps"), `#!/bin/sh\nprintf '%s\\n' ${quote(ps)}\n`);
    chmodSync(join(box.bin, "ps"), 0o755);
    const exited = new Promise<NodeJS.Signals | null>((settle) => spinner.once("exit", (_code, signal) => settle(signal)));
    const ran = box.run(computerUpkeepScript(UPKEEP_LIMITS, box.places));
    expect(ran.status, ran.stderr).toBe(0);
    expect(readUpkeepReport(ran.stdout)?.stopped).toBe(1);
    expect(await exited).toBe("SIGTERM");
    for (const child of [browser, young, quiet]) expect(child.exitCode === null && child.signalCode === null).toBe(true);
  });

  it("spares run_on_computer jobs and touches nothing outside the dog's own downloads, temporary files and caches", () => {
    const script = computerUpkeepScript();
    expect(script).toContain("LATERDOG_RUN_ID=");
    expect(script).toContain(`-user "$(id -u)"`);
    expect(script).toContain('cache="$HOME/.cache/chromium"; downloads="$HOME"/Downloads; temp=/tmp;');
    for (const line of script.split("\n").filter((each) => /\brm -rf\b|-delete\b/.test(each))) {
      expect(line).toMatch(/"\$(cache|downloads|temp|reports)"/);
    }
    expect(readUpkeepReport("noise\n<<laterdog-upkeep>> freed_kb=12 stopped=0\n")).toEqual({ freedBytes: 12 * 1024, stopped: 0 });
    expect(readUpkeepReport("nothing")).toBeNull();
  });
});
