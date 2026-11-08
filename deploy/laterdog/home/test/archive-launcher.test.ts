import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { launcherOwnsNoFile } from "../runtime/archive-launcher.mjs";

function child() {
  const result = Object.assign(new EventEmitter(), {
    connected: true, exitCode: null, signalCode: null,
    send: (_value: any, _callback: (error?: Error) => void) => {},
  });
  return result;
}
it("uses matching private replies and refuses a held launcher file", async () => {
  const launcher = child();
  launcher.send = value => { queueMicrotask(() => launcher.emit("message", { type: "archive.ownership.result", id: value.id, unopened: false })); };
  expect(await launcherOwnsNoFile(launcher, { dev: 1, ino: 2 })).toBe(false);
  launcher.send = value => { queueMicrotask(() => launcher.emit("message", { type: "archive.ownership.result", id: value.id, unopened: true })); };
  expect(await launcherOwnsNoFile(launcher, { dev: 1, ino: 2 })).toBe(true);
  expect(launcher.listenerCount("message")).toBe(0);
});
it("keeps files when a launcher exits, fails to send, times out or replies to another probe", async () => {
  const launcher = child();
  launcher.send = () => { queueMicrotask(() => launcher.emit("exit")); };
  expect(await launcherOwnsNoFile(launcher, { dev: 1, ino: 2 })).toBe(false);
  launcher.send = (_value, callback) => callback(new Error("closed"));
  expect(await launcherOwnsNoFile(launcher, { dev: 1, ino: 2 })).toBe(false);
  launcher.send = () => { queueMicrotask(() => launcher.emit("message", { type: "archive.ownership.result", id: "other-probe", unopened: true })); };
  expect(await launcherOwnsNoFile(launcher, { dev: 1, ino: 2 }, 5)).toBe(false);
  expect(launcher.listenerCount("message")).toBe(0);
  launcher.connected = false;
  expect(await launcherOwnsNoFile(launcher, { dev: 1, ino: 2 })).toBe(false);
});
