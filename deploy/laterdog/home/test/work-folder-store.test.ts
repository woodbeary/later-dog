import { describe, expect, it } from "vitest";
import { workFolderLayoutRecord } from "../../../../shared/work-folder-layout.ts";
import { workFolderAuthority, workFolderBaseUrl, WORK_FOLDER_ACCESS_MS } from "../../../../shared/work-folder-store.ts";
import { handleWorkFolderPlacement, layoutScopes } from "../src/work-folder-placement.ts";
import { handleWorkFolder, type WorkFolderBucket } from "../src/work-folder-store.ts";
import { hex, sha256 } from "../src/encoding.ts";

function fixture() {
  const origin = "https://htest-home.later.dog", stable = "a".repeat(64), bootstrap = "fixture-bootstrap";
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let failVersion = false;
  const bucket: WorkFolderBucket = {
    async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async head(k) { const o = objects.get(k); return o ? { size: o.bytes.length } : null; },
    async get(k) { const o = objects.get(k); return o ? { body: new Response(o.bytes as BodyInit).body!, size: o.bytes.length, etag: o.etag } : null; },
    async put(k, data, opts) {
      if (failVersion && k.includes("/versions/")) { failVersion = false; throw Error("lost version write"); }
      const b = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await new Response(data as BodyInit).arrayBuffer());
      const existing = objects.get(k), cond = opts.onlyIf;
      if ("etagMatches" in cond ? existing?.etag !== cond.etagMatches : existing) return null;
      objects.set(k, { bytes: b, etag: crypto.randomUUID() }); return {};
    },
  };
  const base = workFolderBaseUrl(origin, "dog_A", "task-thread");
  const authority = workFolderAuthority(bootstrap, "dog_A", "task-thread");
  const call = async (path: string, method = "GET", data?: unknown, token?: string, now = 1000, url = base) => handleWorkFolder(new Request(url + "/" + path, { method, headers: { authorization: "Bearer " + (token ?? await authority) }, ...(data === undefined ? {} : { body: typeof data === "string" ? data : JSON.stringify(data) }) }), bucket, stable, origin, bootstrap, now);
  const put = async (kind: string, body: unknown) => {
    const text = typeof body === "string" ? body : JSON.stringify(body), id = hex(await sha256(text));
    const r = await call(kind + "/" + id, "PUT", text);
    return { id, r };
  };
  const empty = async () => {
    const e = await put("manifests", { v: 1, kind: "entries", entries: [] });
    expect(e.r.status).toBe(201);
    const root = await put("manifests", { v: 1, kind: "root", mode: 0o750, entries: e.id });
    expect(root.r.status).toBe(201); return root.id;
  };
  return { origin, base, bucket, stable, bootstrap, call, put, empty, objects, loseVersion: () => { failVersion = true; } };
}

describe("a cloud work folder", () => {
  it("creates a durable directory for a new task, retries without overwriting it and permits an explicit recreation", async () => {
    const f = fixture();
    const make = () => f.call("mkdir", "POST", { mode: 0o750 });
    expect((await make()).status).toBe(423);
    const place = { v: 1, previous: null, mode: "folders", baselineManifest: "0".repeat(64), verification: "1".repeat(64), layout: { dogs: [], tasks: {}, projects: [] } };
    await f.bucket.put("homes/" + f.stable + "/work-folders/placement", JSON.stringify(place), { onlyIf: { etagDoesNotMatch: "*" } });
    const made = await make();
    expect(made.status).toBe(201);
    const first = await made.json() as { revision: string; manifest: string };
    expect(await (await make()).json()).toEqual(first);
    expect(await (await f.call("manifests/" + first.manifest)).json()).toMatchObject({ kind: "root", mode: 0o750 });
    const gone = await f.call("commit", "POST", { parent: first.revision, manifest: null });
    expect(gone.status).toBe(201);
    const retired = await gone.json() as { revision: string };
    expect(await (await make()).json()).toMatchObject({ parent: retired.revision, state: "live" });
  });
  it("publishes only fully uploaded chunk graphs, serves UTF-8 path ranges, bytes and permissions", async () => {
    const f = fixture(), blob = await f.put("blobs", "file\0contents");
    expect(blob.r.status).toBe(201);
    const chunks = await f.put("manifests", { v: 1, kind: "chunks", hashes: [blob.id] });
    const file = { kind: "file", path: "ä/file", size: 13, sha256: blob.id, contents: chunks.id, mode: 0o4511 };
    const one = await f.put("manifests", { v: 1, kind: "entries", entries: [{ kind: "dir", path: "empty", mode: 0o751 }, { kind: "link", path: "link", target: "ä/file" }] });
    const two = await f.put("manifests", { v: 1, kind: "entries", entries: [{ kind: "dir", path: "ä", mode: 0o700 }, file] });
    expect(two.r.status).toBe(201);
    const page = await f.put("manifests", { v: 1, kind: "pages", of: "entries", children: [one.id, two.id] });
    expect(await (await f.call("ranges/" + page.id)).json()).toMatchObject({ self: { count: 4, bytes: 13, first: "empty", last: "ä/file" } });
    const root = await f.put("manifests", { v: 1, kind: "root", entries: page.id, mode: 0o710 });
    const c = await f.call("commit", "POST", { parent: null, manifest: root.id }); expect(c.status).toBe(201);
    expect(await (await f.call("head")).json()).toMatchObject({ parent: null, manifest: root.id, state: "live" });
    expect(await (await f.call("blobs/" + blob.id)).text()).toBe("file\0contents");
    expect(await (await f.call("manifests/" + two.id)).json()).toMatchObject({ entries: [expect.anything(), file] });
    expect((await f.put("manifests", { v: 1, kind: "pages", of: "entries", children: [two.id, one.id] })).r.status).toBe(400);
    expect((await f.put("manifests", { v: 1, kind: "entries", entries: [{ ...file, size: 14 }] })).r.status).toBe(400);
    expect((await f.put("manifests", { v: 1, kind: "chunks", hashes: ["1".repeat(64)] })).r.status).toBe(422);
    expect((await f.call("blobs/" + blob.id, "PUT", "bad")).status).toBe(422);
    expect((await f.put("manifests", { v: 1, kind: "entries", entries: [{ kind: "link", path: "bad", target: "../outside" }] })).r.status).toBe(400);
  });

  it("retains older heads across CAS races, lost responses, explicit deletion and a checked rollback", async () => {
    const f = fixture(), root = await f.empty();
    expect(await (await f.call("head")).json()).toEqual({ error: "never_published" });
    f.loseVersion();
    await expect(f.call("commit", "POST", { parent: null, manifest: root })).rejects.toThrow("lost version");
    const first = await (await f.call("head")).json();
    expect(await (await f.call("versions/" + first.revision)).json()).toEqual(first);
    const alternate = await f.put("manifests", { v: 1, kind: "root", mode: 0o700, entries: (await (await f.call("manifests/" + root)).json()).entries });
    const races = await Promise.all([null, alternate.id].map(manifest => f.call("commit", "POST", { parent: first.revision, manifest })));
    expect(races.map(x => x.status).sort()).toEqual([201,409]);
    const won = await (await f.call("head")).json(); expect(won.parent).toBe(first.revision);
    expect(await (await f.call("commit", "POST", { parent: null, manifest: root })).json()).toEqual(first);
    const deleted = won.state === "tombstone" ? won : await (await f.call("commit", "POST", { parent: won.revision, manifest: null })).json();
    expect(deleted.state).toBe("tombstone");
    const restored = await (await f.call("commit", "POST", { parent: deleted.revision, manifest: first.manifest })).json();
    expect(restored).toMatchObject({ parent: deleted.revision, manifest: root, state: "live" });
    expect(await (await f.call("versions/" + deleted.revision)).json()).toEqual(deleted);
  });

  it("only mints an exact home/dog/folder grant, renews it while the process sleeps and invalidates it on revoke", async () => {
    const f = fixture(), guestId = "cmp_test", issued = await (await f.call("grant", "POST", { guestId })).json();
    expect(issued).toMatchObject({ guestId, baseUrl: f.base, expiresAt: 1000 + WORK_FOLDER_ACCESS_MS });
    const h = await f.put("blobs", "abc");
    expect((await f.call("blobs/" + h.id, "GET", undefined, issued.accessToken)).status).toBe(200);
    expect((await f.call("blobs/" + h.id, "GET", undefined, issued.accessToken, 1000, workFolderBaseUrl(f.origin, "dog_B", "task-thread"))).status).toBe(401);
    expect((await f.call("grant", "POST", { guestId: "cmp_other" }, issued.accessToken)).status).toBe(403);
    expect((await f.call("head", "GET", undefined, issued.refreshToken)).status).toBe(401);
    expect((await f.call("head", "GET", undefined, issued.accessToken, issued.expiresAt)).status).toBe(401);
    const fresh = await (await f.call("refresh", "POST", undefined, issued.refreshToken, issued.expiresAt)).json();
    expect((await f.call("blobs/" + h.id, "GET", undefined, fresh.accessToken, issued.expiresAt)).status).toBe(200);
    expect((await f.call("revoke", "POST", { guestId })).status).toBe(204);
    expect((await f.call("refresh", "POST", undefined, issued.refreshToken)).status).toBe(401);
    const replacement = await (await f.call("grant", "POST", { guestId })).json();
    expect(replacement.refreshToken).not.toBe(issued.refreshToken);
    expect((await f.call("grant", "POST", { guestId: "../outside" })).status).toBe(400);
  });
  it("requires a verified, current, fenced snapshot before switching ownership and revokes former project membership", async () => {
    const f = fixture(), baseline = JSON.stringify({ version: 1, entries: [] }), baselineKey = "homes/" + f.stable + "/manifest.json";
    await f.bucket.put(baselineKey, baseline, { onlyIf: { etagDoesNotMatch: "*" } });
    const project = "/data/shared", projectId = "project-" + hex(await sha256(project));
    const scope = workFolderBaseUrl(f.origin, "dog_A", projectId), authority = await workFolderAuthority(f.bootstrap, "dog_A", projectId);
    const call = (path: string, data: unknown, token = authority) => f.call(path, "POST", data, token, 1000, scope);
    const internal = (path: string, value?: unknown, condition: Record<string, string> = {}) => handleWorkFolderPlacement(new Request("http://state.r2/work-folders/" + path, { method: value === undefined ? "GET" : "PUT", body: value === undefined ? undefined : JSON.stringify(value), headers: condition }), f.bucket, f.stable);
    const assignment = { guestId: "cmp_teammate", granteeBotId: "dog_B" };
    expect((await call("grant", assignment)).status).toBe(403);
    expect((await internal("placement")).status).toBe(404);
    const head = await (await call("commit", { parent: null, manifest: null })).json();
    const baselineManifest = hex(await sha256(baseline));
    const hold = (path: string, body: unknown) => handleWorkFolderPlacement(new Request("http://state.r2/work-folders/retention/" + path, { method: "POST", body: JSON.stringify(body) }), f.bucket, f.stable);
    const leaf = hex(await sha256(JSON.stringify(["leaf", []])));
    expect((await internal("legacy-manifests/" + baselineManifest, JSON.parse(baseline))).status).toBe(201);
    expect((await hold("leaf/" + leaf, { hashes: [] })).status).toBe(200);
    expect((await hold("seal/" + baselineManifest, { root: leaf })).status).toBe(200);
    let previous: string | null = null, oldEtag: string | null = null;
    for (const members of [["dog_A","dog_B"], ["dog_A"]]) {
      const layout = { dogs: [], tasks: {}, projects: [{ path: project, owner: "dog_A", members }] };
      const [subject] = await layoutScopes(layout);
      const checked = { v: 1, mode: "folders", baselineManifest, layoutSha256: hex(await sha256(workFolderLayoutRecord(layout))), scopes: [{ scope: subject, revision: head.revision, manifest: null, sourceTree: baselineManifest, restoredTree: baselineManifest }] };
      const verification = hex(await sha256(JSON.stringify(checked)));
      expect((await internal("verification/" + verification, checked)).status).toBe(201);
      const next = { v: 1, mode: "folders", previous, baselineManifest, verification, layout };
      const condition = oldEtag ? { "if-match": oldEtag } : { "if-none-match": "*" };
      expect((await internal("placement", next, condition)).status).toBe(422);
      const { revision } = await (await internal("scopes")).json();
      const lock = (op: string) => handleWorkFolderPlacement(new Request("http://state.r2/work-folders/registry-" + op, { method: "POST", body: JSON.stringify({ revision, fence: verification }) }), f.bucket, f.stable);
      expect((await lock("fence")).status).toBe(200);
      expect((await call("fence", { revision: head.revision, fence: verification })).status).toBe(200);
      expect((await call("commit", { parent: head.revision, manifest: null })).status).toBe(423);
      expect((await internal("placement", next, condition)).status).toBe(201);
      expect((await internal("placement", next, condition)).status).toBe(200);
      previous = hex(await sha256(JSON.stringify(next)));
      oldEtag = (await internal("placement")).headers.get("etag");
      expect(await (await internal("placements/" + previous)).json()).toEqual(next);
      expect((await call("unfence", { revision: head.revision, fence: verification })).status).toBe(200);
      expect((await lock("unfence")).status).toBe(200);
      const guest = await call("grant", assignment);
      expect(guest.status).toBe(members.length === 2 ? 200 : 403);
      if (guest.ok) {
        const access = (await guest.json()).accessToken;
        expect((await call("fence", { revision: head.revision, fence: verification }, access)).status).toBe(403);
      }
    }
    expect((await call("grant", { guestId: "cmp_stranger", granteeBotId: "outsider" })).status).toBe(403);
  });

  it("rejects incomplete retained snapshot proofs and can repair an original blob after an older collector removes it", async () => {
    const f = fixture();
    const data = "saved bytes", id = hex(await sha256(data)), prefix = "homes/" + f.stable + "/";
    const hold = (path: string, body: unknown) => handleWorkFolderPlacement(new Request("http://state.r2/work-folders/retention/" + path, { method:"POST", body:JSON.stringify(body) }),f.bucket,f.stable);
    const snapshot = JSON.stringify({version:1,entries:[{path:"chunks",type:"file",chunks:[id,id]}]});
    const sha = hex(await sha256(snapshot));
    await f.bucket.put(prefix + "work-folders/legacy-manifests/" + sha, snapshot, {onlyIf:{etagDoesNotMatch:"*"}});
    await f.bucket.put(prefix + "blobs/" + id, data, {onlyIf:{etagDoesNotMatch:"*"}});
    const wrong = hex(await sha256(JSON.stringify(["leaf",[id]]))), good = hex(await sha256(JSON.stringify(["leaf",[id,id]])));
    expect((await hold("leaf/" + wrong,{hashes:[id]})).status).toBe(200);
    expect((await hold("seal/" + sha,{root:wrong})).status).toBe(422);
    expect((await hold("leaf/" + good,{hashes:[id,id]})).status).toBe(200);
    expect((await hold("seal/" + sha,{root:good})).status).toBe(200);
    f.objects.delete(prefix + "blobs/" + id);
    expect((await hold("repair/" + good,{hashes:[id,id]})).status).toBe(200);
    expect(new TextDecoder().decode(f.objects.get(prefix + "blobs/" + id)!.bytes)).toBe(data);
  });

});
