import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  membershipFor,
  initialProjectAccess,
  replaceProjectBindings,
  projectAccessAuthority,
  projectAccessPath,
  projectAccessSchema,
  type ProjectAccess,
  type ProjectBinding,
} from "../../shared/work-folder-project-access.ts";
import { type WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import { visibleWorkspace } from "./work-folder-locations.ts";

export type ProjectSelection = { subject: string; cwd?: string | null; members: string[] };
export type ProjectAccessLoss = { member: string; owner: string; path: string };
type StoreState = {
  revision: string | null;
  verification: string;
  access: ProjectAccess | null;
  operation?: string | null;
};

const within = (root: string, path: string) => {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep);
};
const selectionError = () =>
  Object.assign(new Error("Choose one of the working folders assigned to this cloud home."), { status: 400 });
export function selectionFor(
  layout: WorkFolderLayout,
  dataDir: string,
  selection: ProjectSelection,
): ProjectBinding | null {
  const { cwd, members, subject } = selection;
  if (!cwd || !members.length) return null;
  if (!isAbsolute(cwd) || cwd !== resolve(cwd)) throw selectionError();
  const project = layout.projects.filter((p) => within(p.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
  if (
    project &&
    project.path !== dirname(dataDir) &&
    !within(dataDir, project.path) &&
    !project.path.startsWith(dirname(dataDir) + "/.")
  )
    return { subject, path: project.path, members: [...new Set(members)].sort() };
  if (
    (cwd === dirname(dataDir) || within(visibleWorkspace(dataDir), cwd)) &&
    layout.loose &&
    members.every((m) => m === layout.loose!.owner || layout.loose!.members.includes(m))
  )
    return null;
  if (
    members.length === 1 &&
    [resolve(dataDir, "workspaces", members[0]!), resolve(dataDir, "task-workspaces", members[0]!)].some((root) =>
      within(root, cwd),
    )
  )
    return null;
  throw selectionError();
}

export class ProjectAccessController {
  readonly baseline: WorkFolderLayout;
  readonly layout: WorkFolderLayout;
  readonly dataDir: string;
  readonly origin: string;
  readonly bootstrap: string;
  readonly update: (verification: string, access: ProjectAccess | null) => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    layout: WorkFolderLayout,
    dataDir: string,
    origin: string,
    bootstrap: string,
    update: (verification: string, access: ProjectAccess | null) => void,
  ) {
    this.baseline = structuredClone(layout);
    this.layout = layout;
    this.dataDir = dataDir;
    this.origin = origin;
    this.bootstrap = bootstrap;
    this.update = update;
  }

  async #call(method: string, body?: unknown) {
    return fetch(new URL(projectAccessPath, this.origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: "Bearer " + (await projectAccessAuthority(this.bootstrap)),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async refresh(): Promise<StoreState> {
    const response = await this.#call("GET");
    if (!response.ok)
      throw Object.assign(new Error("The current shared project membership could not be read."), { status: 503 });
    const data = (await response.json()) as StoreState;
    if (!/^[a-f0-9]{64}$/.test(data.verification) || (data.revision !== null && typeof data.revision !== "string"))
      throw new Error("Invalid shared project revision.");
    const access = data.access === null ? null : projectAccessSchema.parse(data.access);
    this.#set(data.verification, access);
    return { ...data, access };
  }

  #set(verification: string, access: ProjectAccess | null) {
    this.update(verification, access);
    this.layout.projects = membershipFor(this.baseline, access).projects;
  }

  binding(selection: ProjectSelection) {
    return selectionFor(this.baseline, this.dataDir, selection);
  }

  async initialize(records: ProjectSelection[]) {
    let current = await this.refresh();
    if (current.operation) {
      const cancelled = await this.#call("DELETE", {
        verification: current.verification,
        operation: current.operation,
      });
      if (!cancelled.ok) throw new Error("A previous shared project update could not be recovered.");
      current = await this.refresh();
    }
    if (current.access) return;
    const bindings = records.flatMap((s) => {
      try {
        return this.binding(s) ?? [];
      } catch {
        return [];
      }
    });
    const access = initialProjectAccess(this.baseline, bindings);
    const response = await this.#call("PUT", { revision: null, verification: current.verification, access });
    if (response.status === 409) {
      await this.refresh();
      return;
    }
    if (!response.ok) throw new Error("The existing project membership could not be retained.");
    this.#set(current.verification, access);
  }

  change(
    owner: boolean,
    selections: ProjectSelection[],
    baseline: () => ProjectSelection[],
    publish: (loss: ProjectAccessLoss[], commit: () => Promise<void>) => Promise<void>,
    removeMember?: string,
  ): Promise<void> {
    const subjects = selections.map((s) => s.subject);
    const bindings = selections.flatMap((s) => this.binding(s) ?? []);
    const run = this.#pending.then(async () => {
      const old = await this.refresh();
      const initial =
        old.access ??
        initialProjectAccess(
          this.baseline,
          baseline().flatMap((s) => {
            try {
              return this.binding(s) ?? [];
            } catch {
              return [];
            }
          }),
        );
      const next = replaceProjectBindings(initial, subjects, bindings);
      if (removeMember) {
        next.inherited = next.inherited.map((row) => ({
          ...row,
          members: row.members.filter((member) => member !== removeMember),
        }));
        next.bindings = next.bindings
          .map((row) => ({ ...row, members: row.members.filter((member) => member !== removeMember) }))
          .filter((row) => row.members.length);
      }
      const equivalent = (a: ProjectAccess) =>
        JSON.stringify({
          inherited: a.inherited,
          bindings: [...a.bindings].sort((x, y) => x.subject.localeCompare(y.subject)),
        });
      if (equivalent(initial) === equivalent(next)) return;
      if (!owner)
        throw Object.assign(new Error("The cloud home owner must change this shared project's access."), {
          status: 403,
        });
      const from = membershipFor(this.baseline, initial),
        to = membershipFor(this.baseline, next);
      const loss = from.projects.flatMap((p, i) =>
        p.members
          .filter((member) => member !== p.owner && !to.projects[i]!.members.includes(member))
          .map((member) => ({ owner: p.owner, path: p.path, member })),
      );
      let operation: string | undefined;
      if (loss.length) {
        const prepared = await this.#call("POST", {
          revision: old.revision,
          verification: old.verification,
          access: next,
        });
        if (!prepared.ok)
          throw Object.assign(new Error("Could not reserve the project access change."), { status: 409 });
        operation = ((await prepared.json()) as { operation: string }).operation;
        if (!operation) throw new Error("Missing project access change identity.");
      }
      try {
        await publish(loss, async () => {
          let saved: Response | undefined;
          try {
            saved = await this.#call(
              "PUT",
              operation
                ? { operation, verification: old.verification }
                : { revision: old.revision, verification: old.verification, access: next },
            );
          } catch {}
          if (!saved?.ok) {
            const actual = await this.refresh();
            if (
              actual.verification !== old.verification ||
              !actual.access ||
              equivalent(actual.access) !== equivalent(next)
            )
              throw Object.assign(
                new Error("Project access changed or could not be saved. Reopen its settings and try again."),
                { status: saved?.status === 409 ? 409 : 503 },
              );
          }
          operation = undefined;
          this.#set(old.verification, next);
        });
      } catch (error) {
        if (operation) {
          const cancelled = await this.#call("DELETE", { verification: old.verification, operation });
          if (!cancelled.ok && cancelled.status !== 409)
            throw new Error("The previous shared project update could not be released.");
        }
        throw error;
      }
    });
    this.#pending = run.catch(() => {});
    return run;
  }
}
