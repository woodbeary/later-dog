import { expect, it, vi } from "vitest";
import { managedDeviceApproval } from "./managed-device-approval.ts";
import type { JobComputer } from "./computer-jobs.ts";

it("binds a device approval to its original guest, scoped folder and process", async () => {
  const scope = { path: "/work/dog", owner: "dog", id: "dog" };
  const sync = vi.fn(async () => {});
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const box = { computerId: "first", exec, read: vi.fn(), write: vi.fn() };
  const computer = vi.fn(async (): Promise<JobComputer> => ({ state: "running", box }));
  const place = managedDeviceApproval({ resolve: (_botId, path) => path === scope.path ? scope : null, sync }, () => true, computer);
  const wait = { botId:"dog",threadId:"thread",messageId:"message",expiresAt:10000,computerId:await place.watchComputer("dog", scope.path) };
  expect(wait.computerId).toBe("first");
  expect(await place.runCheck("check current", scope.path, wait)).toBe(true);
  expect(sync.mock.calls.map(call => (call as unknown[])[3])).toEqual(["hydrate", "checkpoint"]);
  expect(await place.alive(18, wait)).toBe(true);
  expect(exec.mock.lastCall).toEqual(["test -d /proc/18", 20_000]);
  box.computerId = "replacement";
  await expect(place.runCheck("check current", scope.path, wait)).rejects.toThrow("unavailable");
  await expect(place.alive(18, wait)).rejects.toThrow("unavailable");
  expect(exec).toHaveBeenCalledTimes(2);
  await expect(place.watchComputer("dog", "/elsewhere")).rejects.toThrow("assigned");
});
