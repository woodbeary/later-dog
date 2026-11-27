import { describe, expect, it, vi } from "vitest";
import { workFolderAuthority, workFolderBaseUrl } from "../../../../shared/work-folder-store.ts";
import { hex, sha256 } from "../src/encoding.ts";
import type { WorkFolderBucket } from "../src/work-folder-store.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace } = await import("./fake-containers.ts");
const { CloudHomeHost } = await import("../src/host.ts");
const { default: worker } = await import("../src/index.ts");
const { bootstrapSecret, homeIdentity } = await import("../src/identity.ts");
const { handleWorkFolder } = await import("../src/work-folder-store.ts");

const SECRET = "edge-home-secret";
const SUFFIX = "-home.later.dog";

async function home() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const STATE: WorkFolderBucket = {
    async head(k) { const o = objects.get(k); return o ? { size: o.bytes.length } : null; },
    async get(k) { const o = objects.get(k); return o ? { body: new Response(o.bytes as BodyInit).body!, size: o.bytes.length, etag: o.etag } : null; },
    async put(k, data, opts) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await new Response(data as BodyInit).arrayBuffer());
      const old = objects.get(k), cond = opts.onlyIf;
      if ("etagMatches" in cond ? old?.etag !== cond.etagMatches : old) return null;
      objects.set(k, { bytes, etag: crypto.randomUUID() });
      return {};
    },
  };
  const HOMES = new FakeNamespace<InstanceType<typeof CloudHomeHost>>("HOMES");
  const env = { HOME_SECRET: SECRET, HOME_HOST_SUFFIX: SUFFIX, LARGE_HOME_ACCOUNTS: "", HOMES, HOMES_LARGE: new FakeNamespace("HOMES_LARGE"), STATE };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  const { machineId, origin } = await homeIdentity(SECRET, "edge-owner", SUFFIX);
  const bootstrap = await bootstrapSecret(SECRET, machineId);
  const base = workFolderBaseUrl(origin, "dog_A", "task-thread");
  const owner = "Bearer " + await workFolderAuthority(bootstrap, "dog_A", "task-thread");
  const save = async (kind: string, text: string) => {
    const id = hex(await sha256(text));
    const r = await handleWorkFolder(new Request(`${base}/${kind}/${id}`, { method: "PUT", body: text, headers: { authorization: owner } }), STATE, HOMES.idFromName(machineId).toString(), origin, bootstrap);
    expect(r.status).toBe(201);
    return id;
  };
  const visit = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${base}/${path}`, { ...init, headers: { authorization: owner, ...init.headers } }), env as never);
  return { save, visit };
}

describe("working folder reads at the edge", () => {
  it("serves saved folder content without passing through the home, so a big checkout cannot slow the home down", async () => {
    const h = await home();
    const throughHome = vi.spyOn(CloudHomeHost.prototype, "fetch");
    const blob = await h.save("blobs", "file contents");
    const pagesA = await h.save("manifests", JSON.stringify({ v: 1, kind: "entries", entries: [] }));
    const pagesB = await h.save("manifests", JSON.stringify({ v: 1, kind: "chunks", hashes: [blob] }));
    const read = await h.visit("blobs/" + blob);
    expect(await read.text()).toBe("file contents");
    expect(read.headers.get("cache-control")).toContain("immutable");
    expect((await h.visit("blobs/" + blob, { method: "HEAD" })).status).toBe(200);
    const batch = await h.visit("pages", { method: "POST", body: JSON.stringify({ hashes: [pagesB, pagesA] }) });
    expect(((await batch.json()) as { pages: string[] }).pages.map((page) => JSON.parse(page).kind)).toEqual(["chunks", "entries"]);
    expect((await h.visit("pages", { method: "POST", body: JSON.stringify({ hashes: [pagesA, "f".repeat(64)] }) })).status).toBe(404);
    expect((await h.visit("blobs/" + blob, { headers: { authorization: "Bearer wfa_wrong" } })).status).toBe(401);
    expect(throughHome).not.toHaveBeenCalled();
    await h.visit("blobs/" + blob, { method: "PUT", body: "file contents" });
    expect(throughHome).toHaveBeenCalledTimes(1);
    throughHome.mockRestore();
  });
});
