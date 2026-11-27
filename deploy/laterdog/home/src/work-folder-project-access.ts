import {
  membershipFor,
  projectAccessSchema,
  type ProjectAccess,
} from "../../../../shared/work-folder-project-access.ts";
import { type WorkFolderPlacement } from "../../../../shared/work-folder-layout.ts";
import { homePrefix } from "./state.ts";
import { type WorkFolderBucket } from "./work-folder-store.ts";

const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const conflict = () => reply({ error: "project_access_changed" }, 409);
type StoredAccess = {
  access: ProjectAccess;
  epochs: Record<string, string>;
  pending?: { id: string; next: ProjectAccess; losses: string[] };
};
export async function retainedProjectAccess(bucket: WorkFolderBucket, stable: string, placement: WorkFolderPlacement) {
  const key = homePrefix(stable) + "work-folders/project-access/" + placement.verification;
  const record = await bucket.get(key);
  const saved = record ? ((await new Response(record.body).json()) as StoredAccess) : null;
  return {
    key,
    revision: record?.etag ?? null,
    access: saved ? projectAccessSchema.parse(saved.access) : null,
    epochs: saved?.epochs ?? {},
    pending: saved?.pending,
  };
}

export async function changeProjectAccess(
  bucket: WorkFolderBucket,
  stable: string,
  placement: WorkFolderPlacement | null,
  method: string,
  input: { revision?: unknown; verification?: unknown; access?: unknown; operation?: unknown } | null,
) {
  if (placement?.mode !== "folders") return reply({ error: "inactive" }, 423);
  const current = await retainedProjectAccess(bucket, stable, placement);
  if (method === "GET")
    return reply({
      revision: current.revision,
      verification: placement.verification,
      access: current.access,
      operation: current.pending?.id ?? null,
    });
  if (!input || input.verification !== placement.verification) return conflict();
  const store = async (value: StoredAccess) =>
    Boolean(
      await bucket.put(current.key, JSON.stringify(value), {
        onlyIf: current.revision === null ? { etagDoesNotMatch: "*" } : { etagMatches: current.revision },
      }),
    );
  if (current.pending) {
    if (input.operation !== current.pending.id || !current.access) return conflict();
    if (method === "DELETE")
      return (await store({ access: current.access, epochs: current.epochs }))
        ? reply({ cancelled: true })
        : conflict();
    if (method !== "PUT") return conflict();
    const epochs = { ...current.epochs };
    for (const member of current.pending.losses) epochs[member] = crypto.randomUUID();
    return (await store({ access: current.pending.next, epochs })) ? reply({ saved: true }) : conflict();
  }
  if (input.revision !== current.revision || !["PUT", "POST"].includes(method)) return conflict();
  const candidate = projectAccessSchema.safeParse(input.access);
  if (!candidate.success) return reply({ error: "bad_project_access" }, 400);
  const next = candidate.data;
  const allowed = new Set(
    placement.layout.projects.filter((p) => p.path !== "/data" && !p.path.startsWith("/data/.")).map((p) => p.path),
  );
  if (
    [...next.bindings, ...next.inherited].some((row) => !allowed.has(row.path)) ||
    new Set(next.bindings.map((row) => row.subject)).size !== next.bindings.length
  )
    return reply({ error: "unknown_project_or_subject" }, 400);
  const previous = membershipFor(placement.layout, current.access),
    following = membershipFor(placement.layout, next);
  const losses = previous.projects.flatMap((p, i) =>
    p.members
      .filter((m) => m !== p.owner && !following.projects[i]!.members.includes(m))
      .map((m) => JSON.stringify([p.path, m])),
  );
  if (method === "POST" && current.access) {
    const pending = { id: crypto.randomUUID(), next, losses };
    return (await store({ access: current.access, epochs: current.epochs, pending }))
      ? reply({ operation: pending.id })
      : conflict();
  }
  if (losses.length || method !== "PUT") return conflict();
  return (await store({ access: next, epochs: current.epochs })) ? reply({ saved: true }) : conflict();
}
