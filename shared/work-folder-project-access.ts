import { z } from "zod";
import { type WorkFolderLayout } from "./work-folder-layout.ts";
import { WORK_FOLDER_ROUTE } from "./work-folder-store.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const subject = z.string().regex(/^(dog|room):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const members = z.array(id);
export const projectAccessPath = WORK_FOLDER_ROUTE + "project-access";
export const projectBindingSchema = z.object({ subject, path: z.string(), members }).strict();
export const projectAccessSchema = z
  .object({
    bindings: z.array(projectBindingSchema),
    inherited: z.array(z.object({ path: z.string(), members }).strict()),
  })
  .strict();
export type ProjectAccess = z.infer<typeof projectAccessSchema>;
export type ProjectBinding = z.infer<typeof projectBindingSchema>;

export async function projectAccessAuthority(bootstrap: string): Promise<string> {
  if (!bootstrap) throw new Error("Missing working folder authority.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(bootstrap),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode("laterdog.owner-project-access.v1")),
  );
  return "wpa_" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function membershipFor(layout: WorkFolderLayout, access: ProjectAccess | null): WorkFolderLayout {
  if (!access) return layout;
  const roster = new Map<string, Set<string>>();
  for (const row of [...access.inherited, ...access.bindings]) {
    let group = roster.get(row.path);
    if (!group) {
      group = new Set();
      roster.set(row.path, group);
    }
    for (const member of row.members) group.add(member);
  }
  return {
    ...layout,
    projects: layout.projects.map((p) => ({
      ...p,
      members: [...new Set([p.owner, ...(roster.get(p.path) ?? [])])].sort(),
    })),
  };
}

export function initialProjectAccess(layout: WorkFolderLayout, assignments: ProjectBinding[]): ProjectAccess {
  const inherited = layout.projects.map((p) => ({ path: p.path, members: [...p.members] }));
  const bindings: ProjectBinding[] = [];
  for (const assignment of assignments) {
    const project = layout.projects.find((p) => p.path === assignment.path);
    if (!project) continue;
    const members = [
      ...new Set(assignment.members.filter((member) => member === project.owner || project.members.includes(member))),
    ].sort();
    if (members.length) bindings.push({ ...assignment, members });
  }
  for (const row of inherited) {
    const attributed = new Set(bindings.filter((b) => b.path === row.path).flatMap((b) => b.members));
    row.members = row.members.filter((member) => !attributed.has(member));
  }
  return { bindings, inherited };
}

export function replaceProjectBindings(
  current: ProjectAccess,
  subjects: string[],
  bindings: ProjectBinding[],
): ProjectAccess {
  const changed = new Set(subjects);
  return {
    inherited: current.inherited,
    bindings: [...current.bindings.filter((b) => !changed.has(b.subject)), ...bindings],
  };
}
