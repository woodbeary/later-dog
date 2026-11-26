import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const socket = "/run/laterdog-history-maintenance/control.sock";
const leasePattern = /^[a-f0-9]{64}$/;

export function parkRequest(socketPath, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, timeout: 30_000 }, (res) => {
      let text = "";
      res.on("error", reject);
      res.on("data", (bytes) => {
        text += bytes;
        if (text.length > 8192) req.destroy(Error("Unexpected maintenance response"));
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          reject(Error("Maintenance request refused: " + res.statusCode));
        else {
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    req.on("timeout", () => req.destroy(Error("Maintenance request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function parkLauncher(child, timeoutMs = 30_000) {
  if (!child?.connected || child.exitCode !== null || child.signalCode !== null)
    throw Error("The original launcher is not available");
  const id = randomUUID();
  let clean = false;
  await new Promise((resolve, reject) => {
    const stop = (error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) => {
      if (message?.type === "history.home.parked" && message.id === id) clean = message.clean === true;
    };
    const onExit = (code, signal) =>
      stop(clean && code === 0 && !signal ? null : Error("The server did not confirm complete shutdown"));
    const timer = setTimeout(() => stop(Error("The launcher did not confirm complete shutdown in time")), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ type: "history.home.park", id }, (error) => {
      if (error) stop(error);
    });
  });
}

export function verifyDrainedHistory(home, mode) {
  if (mode !== "remote") return;
  const db = new DatabaseSync(join(home, "history-control.db"), { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM history_outbox LIMIT 1").get())
      throw Error("Conversation writes still need delivery");
  } finally {
    db.close();
  }
}

export function checkHistorySnapshot(mode, result) {
  if (!result || result.unsaved.length || result.deferred || !Array.isArray(result.manifest?.entries))
    throw Error("Incomplete maintenance snapshot");
  const expected = mode === "remote" ? ".laterdog/history-control.db" : ".laterdog/messages.db";
  if (!result.manifest.entries.some((e) => e.path === expected && e.type === "file"))
    throw Error("Conversation storage is missing from the saved home");
}

export async function openHistoryPark({ canPark, stopChild, save, resume, mode, generation, socketPath = socket }) {
  await mkdir(join(socketPath, ".."), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const boot = randomUUID();
  let parked = null;
  let job = null;
  const describe = () => ({
    boot,
    mode,
    generation,
    phase: parked?.phase ?? "serving",
    ...(parked?.manifest ? { manifest: parked.manifest, entries: parked.entries } : {}),
  });
  const run = () => {
    parked.phase = "parking";
    job = Promise.resolve()
      .then(stopChild)
      .then(save)
      .then((result) => {
        checkHistorySnapshot(mode, result);
        parked.manifest = createHash("sha256").update(JSON.stringify(result.manifest)).digest("hex");
        parked.entries = result.manifest.entries.length;
        parked.phase = "saved";
      })
      .catch((error) => {
        parked.phase = "failed";
        console.error("Home maintenance save failed:", error.message);
      })
      .finally(() => {
        job = null;
      });
  };
  const server = createServer(async (req, res) => {
    const respond = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const [, action, lease] = (req.url ?? "").split("/");
      if (!leasePattern.test(lease) || req.method !== "POST" || (parked && parked.lease !== lease))
        return respond(403, {});
      if (action === "park" && !parked) {
        if (!canPark()) return respond(409, {});
        parked = { lease, phase: "parking" };
        run();
      } else if (action === "retry" && parked?.phase === "failed" && !job) run();
      else if (action === "abort" && parked) {
        if (job) return respond(409, {});
        job = Promise.resolve().then(resume);
        try {
          await job;
          parked = null;
        } finally {
          job = null;
        }
      } else if (!["park", "status", "retry", "abort"].includes(action)) return respond(404, {});
      respond(200, describe());
    } catch {
      respond(500, {});
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  return {
    active: () => parked !== null,
    saved: () => parked?.phase === "saved",
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, lease] = process.argv.slice(2);
  if (!["park", "status", "retry", "abort"].includes(action) || !leasePattern.test(lease))
    throw Error("Invalid maintenance operation");
  process.stdout.write(JSON.stringify(await parkRequest(socket, "/" + action + "/" + lease, "POST")));
}
