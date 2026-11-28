import { relative, isAbsolute, dirname } from "node:path";
import { engineComputer, ENGINE_BOOT_BUDGET_MS } from "../computers.ts";
import {
  ENGINE_PREPARE_BUDGET_MS,
  ENGINE_STEP_BUDGET_MS,
  engineScripts,
  prepareEngineComputer,
  prepareEngineFolderTools,
  processStreamLink,
  relayCommand,
} from "./engine-computer.ts";
import type { EngineOpener } from "./engine-placement.ts";
import type { EngineFileRoot } from "./engine-files.ts";
import { guestFolderDir, type EngineWorkFolder } from "./engine-folder-sync.ts";

export type EngineWorkFolders = (input: {
  botId: string;
  threadId: string;
  cwd: string;
  computerId: string;
  roots: readonly EngineFileRoot[];
}) => Promise<EngineWorkFolder[]>;
export const ENGINE_OPEN_BUDGET_MS = ENGINE_BOOT_BUDGET_MS + ENGINE_PREPARE_BUDGET_MS + ENGINE_STEP_BUDGET_MS;
const inside = (folder: string, path: string) => {
  const sub = relative(folder, path);
  return sub !== ".." && !sub.startsWith("../") && !isAbsolute(sub);
};

function checkAssignments(folders: EngineWorkFolder[], computerId: string): void {
  for (const f of folders) {
    guestFolderDir(f.path);
    if (
      f.grant.guestId !== computerId ||
      folders.some((other) => other !== f && (inside(f.path, other.path) || inside(other.path, f.path)))
    )
      throw new Error("Working folders must have distinct paths and grants belonging to this computer");
  }
}

export type EngineMachine = Awaited<ReturnType<typeof engineComputer>>;

export async function openEngineOnMachine(
  machine: EngineMachine,
  botId: string,
  plan: Parameters<EngineOpener["open"]>[1],
  options: { workFolders?: EngineWorkFolders } = {},
) {
  const relay = engineScripts(Boolean(plan.guestRuntime));
  const { box, stream } = machine;
  if (options.workFolders && box.computerId) {
    const folders = await options.workFolders({
      botId,
      threadId: plan.threadId,
      cwd: plan.launch.cwd,
      computerId: box.computerId,
      roots: plan.launch.roots,
    });
    checkAssignments(folders, box.computerId);
    if (folders.length) {
      const kept = plan.launch.roots.filter(
        (root) =>
          !folders.some((folder) => {
            if (!inside(folder.path, root.path)) return false;
            if (root.id !== "workspace" && root.id !== "bot" && root.id !== "bot-workspace")
              throw new Error("An assigned working folder overlaps a private engine profile");
            return true;
          }),
      );
      plan.launch.roots = kept;
      plan.launch.outputIds = plan.launch.outputIds.filter((id) => kept.some((root) => root.id === id));
      const projects = folders.filter(
        (folder) =>
          dirname(folder.path) === "/data" &&
          new URL(folder.grant.baseUrl).pathname.split("/").at(-1)?.startsWith("project-"),
      );
      plan.launch.workFolders = [...projects, ...folders.filter((f) => !projects.includes(f))].map((folder) =>
        projects.includes(folder)
          ? folder
          : { ...folder, linkProjects: folder.linkProjects ?? projects.map((project) => project.path) },
      );
      await prepareEngineFolderTools(box, folders);
    }
  }
  await prepareEngineComputer(box, plan, relay);
  return processStreamLink(await stream(), relayCommand(relay));
}

export function computerEngineOpener(options: { workFolders?: EngineWorkFolders } = {}): EngineOpener {
  return {
    get proxyPath() {
      return engineScripts().proxy;
    },
    get guestProvider() {
      const relay = engineScripts(true);
      return { entry: relay.dir + "/provider-guest.mjs", proxy: relay.proxy };
    },
    openBudgetMs: ENGINE_OPEN_BUDGET_MS,
    async open(botId, plan, signal) {
      return openEngineOnMachine(await engineComputer(botId, signal), botId, plan, options);
    },
  };
}

export async function syncGuestWorkFolders(
  botId: string,
  assignment: (computerId: string) => Promise<EngineWorkFolder[]>,
  action: "hydrate" | "checkpoint",
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { box, stream } = await engineComputer(botId, signal);
  if (!box.computerId) throw new Error("Missing working folder computer identity");
  const folders = await assignment(box.computerId);
  for (const folder of folders) await syncComputerWorkFolder({ box, stream }, folder, action, signal);
}

export async function syncComputerWorkFolder(
  machine: Awaited<ReturnType<typeof engineComputer>>,
  scope: EngineWorkFolder,
  action: "hydrate" | "checkpoint",
  signal?: AbortSignal,
): Promise<void> {
  const { box, stream } = machine;
  if (!box.computerId) throw new Error("Missing working folder computer identity");
  const folders = [scope];
  checkAssignments(folders, box.computerId);

  await prepareEngineFolderTools(box, folders);
  const relay = engineScripts();
  const prepare = await box.exec(`mkdir -p '${relay.dir}' && test -f '${relay.dir}/.ready'`, ENGINE_STEP_BUDGET_MS);
  if (prepare.exitCode !== 0) {
    for (const file of relay.files) await box.write(relay.dir + "/" + file.name, file.bytes);
    const ready = await box.exec(`touch '${relay.dir}/.ready'`, ENGINE_STEP_BUDGET_MS);
    if (ready.exitCode !== 0) throw new Error("Unable to prepare the working folder relay");
  }
  const link = processStreamLink(await stream(), relayCommand(relay));
  try {
    await new Promise<void>((ok, fail) => {
      const abort = () => {
        link.close();
        fail(new Error("Working folder operation was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      link.once("close", () => {
        signal?.removeEventListener("abort", abort);
        fail(new Error("The guest folder connection closed before its durable receipt"));
      });
      link.on("line", (line: string) => {
        const frame = JSON.parse(line);
        if (frame.type === "ready")
          link.send(JSON.stringify({ type: "guest_folder_once", id: 1, action, workFolders: folders }));
        if (frame.type === "reply" && frame.id === 1) {
          if (frame.body?.saved === true) ok();
          else fail(new Error(frame.body?.error || "Working folder synchronization failed"));
        }
      });
    });
  } finally {
    link.close();
  }
}
