import { DEVICE_APPROVAL_CHECK_TIMEOUT_MS, processAlive, runDeviceCheck, type DeviceApprovalWait } from "./device-approval.ts";
import type { JobComputer } from "./computer-jobs.ts";
import type { FolderScope } from "./work-folder-locations.ts";
import type { SyncRunFolder } from "./computer-runs.ts";
import { shellQuote } from "./laterdog-cloud.ts";

export function managedDeviceApproval(
  folders: { resolve(botId: string, path: string): FolderScope | null; sync: SyncRunFolder } | null,
  placed: (botId: string) => boolean,
  getComputer: (botId: string) => Promise<JobComputer>,
) {
  async function assigned(wait: Pick<DeviceApprovalWait, "botId" | "computerId">) {
    const computer = await getComputer(wait.botId);
    if (computer.state !== "running" || !computer.box.computerId || wait.computerId && computer.box.computerId !== wait.computerId) {
      throw new Error("The computer running the sign-in is unavailable.");
    }
    return computer.box;
  }
  return {
    async watchComputer(botId: string, cwd: string) {
      if (!folders || !placed(botId)) return undefined;
      if (!folders.resolve(botId, cwd)) throw new Error("The sign-in folder is not assigned to this dog.");
      return (await assigned({ botId })).computerId;
    },
    async runCheck(command: string, cwd: string | undefined, wait: DeviceApprovalWait) {
      if (!wait.computerId) return runDeviceCheck(command, cwd);
      const scope = cwd && folders?.resolve(wait.botId, cwd);
      if (!scope || !folders || !cwd) return false;
      const box = await assigned(wait);
      await folders.sync(box, wait.botId, scope, "hydrate");
      const cd = `scope=$(cd -P -- ${shellQuote(scope.path)} && pwd -P) && cd -P -- ${shellQuote(cwd)} && case "$PWD" in "$scope"|"$scope"/*) ;; *) exit 1;; esac`;
      try { return (await box.exec(`${cd} && bash -lc ${shellQuote(command)}`, DEVICE_APPROVAL_CHECK_TIMEOUT_MS)).exitCode === 0; }
      finally { await folders.sync(box, wait.botId, scope, "checkpoint"); }
    },
    alive(pid: number, wait: DeviceApprovalWait): boolean | Promise<boolean> {
      if (!wait.computerId) return processAlive(pid);
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid sign-in process identity.");
      return assigned(wait).then(async box => {
        const result = await box.exec(`test -d /proc/${pid}`, DEVICE_APPROVAL_CHECK_TIMEOUT_MS);
        if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error("The sign-in process status is unavailable.");
        return result.exitCode === 0;
      });
    },
  };
}
