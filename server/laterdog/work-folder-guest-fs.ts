import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { engineComputer } from "../computers.ts";
import { processStreamLink } from "./engine-computer.ts";
import type { EngineLink } from "./engine-remote.ts";
import type { RunBox } from "./computer-runs.ts";
import { folderError } from "./work-folder-namespace.ts";
import type { FolderScope } from "./work-folder-locations.ts";
import type { WorkFolderGrant } from "../../shared/work-folder-store.ts";

export type FsRequest = { op: string; root: string; path: string; handle?: string; newPath?: string; source?: string; [key: string]: unknown };
export type FsReply = { ok: boolean; errno?: string; handle?: string; [key: string]: unknown };
export type FolderMachine = Awaited<ReturnType<typeof engineComputer>>;
type MountedGuestFolder = { path: string; grant: WorkFolderGrant; aliases?: { name: string; target: string }[]; linkProjects?: string[] };
export type SyncFolder = (machine: FolderMachine, folder: MountedGuestFolder, action: "hydrate" | "checkpoint") => Promise<void>;

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const helperBytes = () => readFile("/app/cloud/bin/laterdog-work-folder-mount");
let payload: Promise<{ bytes: Buffer; hash: string }> | undefined;
async function guestBinary(box: RunBox): Promise<string> {
  const { bytes, hash } = await (payload ??= helperBytes().then(bytes => ({ bytes, hash: createHash("sha256").update(bytes).digest("hex") })));
  const directory = "/home/dog/.laterdog-engine/fs-tools/" + hash;
  const target = directory + "/laterdog-work-folder-mount";
  const verify = "printf '%s  %s\\n' " + quote(hash) + " " + quote(target) + " | sha256sum -c --status";
  if ((await box.exec(verify, 15_000)).exitCode === 0) return target;
  const temporary = directory + "/incoming-" + randomUUID();
  if ((await box.exec("umask 077 && mkdir -p " + quote(directory) + " && mkdir " + quote(temporary), 20_000)).exitCode !== 0) throw folderError("EIO");
  try {
    for (let offset = 0, i = 0; offset < bytes.length; offset += 1024 * 1024, i++) {
      await box.write(temporary + "/part-" + String(i).padStart(6, "0"), bytes.subarray(offset, offset + 1024 * 1024));
    }
    const file = temporary + "/assembled";
    const install = "cat " + quote(temporary) + "/part-* > " + quote(file) + " && printf '%s  %s\\n' " + quote(hash) + " " + quote(file) +
      " | sha256sum -c --status && chmod 0700 " + quote(file) + " && mv -f " + quote(file) + " " + quote(target) + " && " + verify;
    if ((await box.exec(install, 30_000)).exitCode !== 0) throw folderError("EIO");
  } finally {
    await box.exec("rm -f " + quote(temporary) + "/part-* " + quote(temporary + "/assembled") + " && rmdir " + quote(temporary), 15_000).catch(() => {});
  }
  return target;
}

export class GuestFsChannel {
  private pending = new Map<string, { resolve: (r: FsReply) => void; reject: (e: Error) => void }>();
  private stopped = false;
  private sequence = 0;
  readonly ready: Promise<void>;
  private fail = () => {};
  private readonly link: EngineLink;
  constructor(link: EngineLink) {
    this.link = link;
    let started = () => {};
    this.ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      this.fail = () => {
        this.stopped = true;
        reject(folderError("EIO"));
        for (const request of this.pending.values()) request.reject(folderError("EIO"));
        this.pending.clear();
      };
    });
    link.on("close", this.fail);
    link.on("error", this.fail);
    link.on("line", (line: string) => {
      try {
        const value = JSON.parse(line);
        if (value.ready === true && value.version === 1) { started(); return; }
        const id = String(value.id);
        const request = this.pending.get(id);
        if (!request || typeof value.response?.ok !== "boolean") throw folderError("EIO");
        this.pending.delete(id);
        request.resolve(value.response);
      } catch {
        this.fail();
        link.close();
      }
    });
  }
  get closed(): boolean { return this.stopped; }
  async call(request: FsRequest): Promise<FsReply> {
    if (this.stopped) throw folderError("EIO");
    const id = String(++this.sequence);
    const timeout = setTimeout(() => this.close(), 90_000);
    try {
      return await new Promise<FsReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.link.send(JSON.stringify({ id, request }));
      });
    } finally {
      clearTimeout(timeout);
      this.pending.delete(id);
    }
  }
  close(): void {
    this.fail();
    this.link.close();
  }
}

export interface GuestFolderAccess {
  channel: GuestFsChannel;
  checkpoint(): Promise<void>;
}

export async function openGuestFolder(
  scope: FolderScope, prepare: (computer: string) => Promise<{ folder: MountedGuestFolder; projects: MountedGuestFolder[] }>, sync: SyncFolder,
): Promise<GuestFolderAccess> {
  const machine = await engineComputer(scope.owner);
  if (!machine.box.computerId) throw folderError("ENODEV");
  const { folder, projects } = await prepare(machine.box.computerId);
  const hydrate = async () => {
    for (const project of projects) await sync(machine, project, "hydrate");
    await sync(machine, folder, "hydrate");
  };
  const [binary] = await Promise.all([guestBinary(machine.box), hydrate()]);
  const channel = new GuestFsChannel(processStreamLink(await machine.stream(), "exec " + quote(binary) + " --stdio --root " + quote(scope.id) + " --directory " + quote(scope.path)));
  const timeout = setTimeout(() => channel.close(), 30_000);
  try { await channel.ready; } finally { clearTimeout(timeout); }
  return { channel, checkpoint: () => sync(machine, folder, "checkpoint") };
}
