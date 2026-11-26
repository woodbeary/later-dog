import { createHash } from "node:crypto";
import { reversePublication } from "./reverse-publication.mjs";

const hash = /^[a-f0-9]{64}$/;
const denied = reason => Response.json({ error: reason }, { status: 423 });

export function validateCutoverBinding(config, authority) {
  if (!authority) {
    if (config.services?.some(binding => binding.binding === "CUTOVER")) throw new Error("Missing scoped cutover authority file");
    return;
  }
  const matches = config.services?.filter(binding => binding.binding === "CUTOVER" && binding.service === authority.service && binding.entrypoint === "WorkFolderMigrationApi" && binding.remote === true);
  const sources = authority.direction === "reverse" ? [authority.previous, authority.sourceManifest] : [authority.image, authority.candidate];
  if (authority.direction !== undefined && authority.direction !== "forward" && authority.direction !== "reverse") throw new Error("Unknown tenant cutover direction");
  if (matches?.length !== 1 || !authority.accountId || !/^h[a-f0-9]{24}$/.test(authority.machineId) || ![authority.nonce, authority.verification, authority.baselineManifest, ...sources].every(id => hash.test(id))) throw new Error("Invalid tenant cutover binding or authority");
}

export async function enrolledPublication(request, bucket, stable, api, authority) {
  const path = new URL(request.url).pathname;
  if (!(path === "/work-folders/placement" && request.method === "PUT" || path === "/work-folders/project-legacy" && request.method === "POST")) return null;
  const prefix = "homes/" + stable + "/work-folders/";
  const held = await bucket.get(prefix + "cutover-enrollment");
  const enrollment = held ? await new Response(held.body).json() : null;
  const reverse = await reversePublication(request, bucket, prefix, api, authority, enrollment, await bucket.get(prefix + "reverse-enrollment"));
  if (reverse) return reverse;
  if (!enrollment) return authority ? denied("source_enrollment_missing") : null;
  if (enrollment.v === 1 && enrollment.retired === true && hash.test(enrollment.retiredRevision)) {
    const record = await bucket.get(prefix + "placements/" + enrollment.retiredRevision);
    if (!record || createHash("sha256").update(await new Response(record.body).text()).digest("hex") !== enrollment.retiredRevision) return denied("unverified_source_retirement");
    if (!authority) return null;
  }
  if (!authority || !api || path !== "/work-folders/placement") return denied("enrolled_source_requires_coordinated_publication");
  if (enrollment.v !== 1 || enrollment.machineId !== authority.machineId || enrollment.lease !== authority.nonce || enrollment.image !== authority.image) return denied("source_enrollment_changed");
  const body = await request.text();
  const placement = JSON.parse(body);
  if (placement.mode !== "folders" || placement.verification !== authority.verification || placement.baselineManifest !== authority.baselineManifest) return denied("unapproved_cutover");
  const match = request.headers.get("if-match"), none = request.headers.get("if-none-match");
  if (placement.previous === null ? match || none !== "*" : !match || none) return denied("missing_placement_precondition");
  const expected = createHash("sha256").update(body).digest("hex");
  if (enrollment.retired === true) {
    if (enrollment.retiredRevision !== expected) return denied("source_retired_with_different_placement");
  } else {
    const proposal = { op: "publish", placement, precondition: match ? { "if-match": match } : { "if-none-match": "*" }, candidate: authority.candidate };
    const receipt = await api.cutover(authority.accountId, authority.nonce, proposal);
    if (receipt?.phase !== "committed" || receipt.revision !== expected) return denied("unconfirmed_enrolled_cutover");
  }
  const current = await bucket.get(prefix + "placement");
  if (!current || createHash("sha256").update(new Uint8Array(await new Response(current.body).arrayBuffer())).digest("hex") !== expected) return denied("unconfirmed_enrolled_storage");
  return Response.json({ revision: expected });
}
