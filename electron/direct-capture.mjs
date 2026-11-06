import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const DIRECT_CAPTURE_TIMEOUT_MS = 120_000;

export function needsDirectCapture({ platform = process.platform, release = os.release() } = {}) {
  return platform === "darwin" && Number.parseInt(String(release).split(".")[0], 10) >= 25;
}

export function createDirectCapture({ file, tmpDir = os.tmpdir(), spawnImpl = spawn, timeoutMs = DIRECT_CAPTURE_TIMEOUT_MS, now = Date.now, version = "" } = {}) {
  let probing = null;
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  };
  const capture = () => new Promise(resolve => {
    const shot = path.join(tmpDir, `laterdog-direct-capture-${process.pid}-${now()}.png`);
    let child;
    try {
      child = spawnImpl("/usr/sbin/screencapture", ["-x", "-t", "png", shot], { stdio: "ignore" });
    } catch { return resolve(false); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    const finish = ok => {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(shot).size; } catch {}
      try { fs.rmSync(shot, { force: true }); } catch {}
      resolve(ok && size > 0);
    };
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
  });
  return {
    verified: () => Boolean(read()?.verifiedAt),
    probing: () => probing !== null,
    async verify() {
      if (this.verified()) return true;
      probing ??= capture().then(ok => {
        if (ok) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ verifiedAt: new Date(now()).toISOString(), version }), { mode: 0o600 });
        }
        return ok;
      }).finally(() => { probing = null; });
      return probing;
    },
  };
}
