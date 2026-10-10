import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";

export const SERVER_LIVENESS_INTERVAL_MS = 15_000;

export function probeServerPort(port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const settle = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => settle("unknown"));
    socket.once("connect", () => settle("open"));
    socket.once("error", (error) => settle(error.code === "ECONNREFUSED" ? "refused" : "unknown"));
  });
}

const zombie = (state) => state.trimStart().startsWith("Z");

export async function serverProcessEnded(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => (error.code === "ENOENT" ? null : ""));
    return stat === null || zombie(stat.slice(stat.lastIndexOf(")") + 1));
  }
  if (platform !== "darwin") return false;
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "stat=", "-p", String(pid)], (error, stdout) => resolve(error ? error.code === 1 : zombie(stdout)));
  });
}

export function createServerLiveness({
  port,
  log = () => {},
  intervalMs = SERVER_LIVENESS_INTERVAL_MS,
  probe = probeServerPort,
  ended = serverProcessEnded,
}) {
  let watch = null;

  function stop() {
    if (watch) clearTimeout(watch.timer);
    watch = null;
  }

  async function lost(proc, current) {
    return (await probe(port())) === "refused" && watch === current && (await ended(proc.pid));
  }

  function start(proc) {
    stop();
    const current = { timer: null };
    watch = current;
    const later = () => {
      current.timer = setTimeout(check, intervalMs);
      current.timer.unref?.();
    };
    const check = async () => {
      const gone = await lost(proc, current).catch(() => false);
      if (watch !== current) return;
      if (!gone) return later();
      watch = null;
      log(`server pid=${proc.pid} ended without an exit event`);
      proc.emit("exit", null);
    };
    later();
  }

  return { start, stop };
}
