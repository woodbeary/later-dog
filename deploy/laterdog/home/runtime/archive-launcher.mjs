import { randomUUID } from "node:crypto";

export function launcherOwnsNoFile(child, target, timeoutMs = 2000) {
  if (!child?.connected || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  return new Promise(resolve => {
    const id = randomUUID();
    const finish = safe => {
      clearTimeout(timer);
      child.off("message", reply);
      child.off("exit", exited);
      resolve(safe);
    };
    const reply = value => {
      if (value?.type === "archive.ownership.result" && value.id === id) finish(value.unopened === true);
    };
    const exited = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.on("message", reply);
    child.once("exit", exited);
    try {
      child.send({ type: "archive.ownership", id, target: { dev: target.dev, ino: target.ino } },
        error => { if (error) finish(false); });
    } catch { finish(false); }
  });
}
