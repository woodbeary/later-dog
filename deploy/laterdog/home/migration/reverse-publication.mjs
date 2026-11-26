import { createHash } from "node:crypto";

const hash = /^[a-f0-9]{64}$/;
const denied = reason => Response.json({ error: reason }, { status: 423 });
const digest = data => createHash("sha256").update(data).digest("hex");
const matches = (left, right) => typeof left === "string" && hash.test(left) && left === right;

async function verifies(bucket, key, expected) {
  const row = await bucket.get(key);
  if (!row) return false;
  const hasher = createHash("sha256");
  for await (const part of row.body) hasher.update(part);
  return hasher.digest("hex") === expected;
}

export async function reversePublication(request, bucket, prefix, api, authority, forward, entry) {
  if (!entry) return authority?.direction === "reverse" ? denied("reverse_enrollment_missing") : null;
  const enrollment = await new Response(entry.body).json();
  const previous = enrollment.previous;
  if (enrollment.v !== 1 || !hash.test(previous)) return denied("invalid_reverse_enrollment");
  const completed = Object.hasOwn(enrollment, "completedRevision");
  if (completed) {
    if (!hash.test(enrollment.completedRevision) || !await verifies(bucket, prefix + "placements/" + enrollment.completedRevision, enrollment.completedRevision)) return denied("unverified_reverse_completion");
    if (authority?.direction !== "reverse") return null;
  } else {
    if (!forward || forward.v !== 1 || forward.retired !== true || forward.machineId !== enrollment.machineId || !matches(forward.retiredRevision, previous) || !await verifies(bucket, prefix + "placements/" + previous, previous)) return denied("forward_retirement_changed");
  }
  if (!api || authority?.direction !== "reverse" || authority.machineId !== enrollment.machineId || authority.nonce !== enrollment.lease || !matches(authority.previous, previous)) return denied("enrolled_reverse_requires_coordinated_publication");
  const projecting = new URL(request.url).pathname === "/work-folders/project-legacy";
  const raw = await request.text();
  let value;
  try { value = JSON.parse(raw); } catch { return denied("invalid_reverse_payload"); }
  const placement = projecting ? value?.placement : value;
  if (placement?.mode !== "legacy" || !matches(placement.previous, previous) || !matches(placement.verification, authority.verification) || !matches(placement.baselineManifest, authority.baselineManifest)) return denied("unapproved_reverse");
  const etag = request.headers.get("if-match");
  if (!etag || !/^"[^",]+"$/.test(etag) || request.headers.has("if-none-match") || projecting && !matches(value.source, authority.sourceManifest)) return denied("invalid_reverse_precondition");
  const expected = digest(projecting ? JSON.stringify(placement) : raw);
  const baseline = placement.baselineManifest, key = prefix.slice(0, -"work-folders/".length) + "manifest.json";
  if (completed) {
    if (!matches(enrollment.completedRevision, expected) || !await verifies(bucket, prefix + "placement", expected) || !await verifies(bucket, prefix + "legacy-manifests/" + baseline, baseline)) return denied("reverse_completed_with_different_storage");
  } else {
    const proposal = projecting ? { op: "project", source: value.source, placement, etag } : { op: "publish", placement, precondition: { "if-match": etag } };
    const reply = await api.reverse(authority.accountId, authority.nonce, proposal);
    if (!matches(reply?.revision, expected) || !(reply.phase === "committed" || projecting && reply.phase === "projected")) return denied("unconfirmed_enrolled_reverse");
    if (!await verifies(bucket, key, baseline) || (!projecting || reply.phase === "committed") && !await verifies(bucket, prefix + "placement", expected)) return denied("unconfirmed_reverse_storage");
  }
  return Response.json({ revision: projecting ? baseline : expected });
}
