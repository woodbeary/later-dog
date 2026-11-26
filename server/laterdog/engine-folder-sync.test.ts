import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  linkSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  realpathSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWorkFolder, type WorkFolderBucket } from "../../deploy/laterdog/home/src/work-folder-store.ts";
import { workFolderAuthority, type WorkFolderGrant } from "../../shared/work-folder-store.ts";
import { folderHash, FolderStore } from "./engine-folder-store.ts";
import { publishInitialWorkFolder } from "./engine-folder-files.ts";
import { retireEmptyGuestFolder, syncFolder } from "./engine-folder-sync.ts";

const garbage: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (garbage.length) rmSync(garbage.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const origin = "http://127.0.0.1:7490",
    base = origin + "/api/work-folders/v1/dog/project",
    secret = "test-bootstrap";
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dog-folders-")));
  garbage.push(dir);
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const bucket: WorkFolderBucket = {
    async list({prefix}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};},
    async head(k) {
      const hit = objects.get(k);
      return hit ? { size: hit.bytes.byteLength } : null;
    },
    async get(k) {
      const hit = objects.get(k);
      return hit
        ? { etag: hit.etag, size: hit.bytes.byteLength, body: new Response(Buffer.from(hit.bytes)).body! }
        : null;
    },
    async put(k, data, opts) {
      const old = objects.get(k),
        cond = opts.onlyIf;
      if ("etagMatches" in cond ? old?.etag !== cond.etagMatches : old) return null;
      const bytes =
        typeof data === "string"
          ? Buffer.from(data)
          : data instanceof ReadableStream
            ? new Uint8Array(await new Response(data).arrayBuffer())
            : new Uint8Array(data);
      objects.set(k, { bytes, etag: crypto.randomUUID() });
      return {};
    },
  };
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) =>
    handleWorkFolder(new Request(url, options), bucket, "0".repeat(64), origin, secret),
  );
  const owner = await workFolderAuthority(secret, "dog", "project");
  async function grant(id: string, folderId = "project") {
    const authority = await workFolderAuthority(secret, "dog", folderId);
    const r = await fetch(origin + "/api/work-folders/v1/dog/" + folderId + "/grant", {
      method: "POST",
      headers: { authorization: "Bearer " + authority },
      body: JSON.stringify({ guestId: id }),
    });
    if (!r.ok) throw Error("Fixture grant failed " + r.status);
    return (await r.json()) as WorkFolderGrant;
  }
  const a = await grant("cmp_alpha"),
    b = await grant("cmp_beta");
  const store = new FolderStore(a, () => {}),
    src = join(dir, "source"),
    left = join(dir, "left"),
    right = join(dir, "right");
  mkdirSync(src);
  const state = join(dir, "state");
  return {
    src,
    store,
    objects,
    base,
    owner,
    state,
    dir,
    grant,
    left,
    right,
    a,
    b,
    syncA: () => syncFolder({ path: left, grant: a }, state),
    syncB: () => syncFolder({ path: right, grant: b }, state),
  };
}

describe("assigned working folders on guest computers", () => {
  it("removes only an empty directory and preserves an unpublished file written directly on the computer", async () => {
    const f = await fixture();
    await publishInitialWorkFolder(f.src, f.store);
    await f.syncA();
    const path = join(f.left, "unsaved");
    writeFileSync(path, "keep this");
    await expect(retireEmptyGuestFolder(f.left, f.state)).rejects.toHaveProperty("code", "ENOTEMPTY");
    expect((await f.store.head())?.state).toBe("live");
    expect(readFileSync(path, "utf8")).toBe("keep this");
    rmSync(path);
    expect(await retireEmptyGuestFolder(f.left, f.state)).toBe(true);
    expect((await f.store.head())?.state).toBe("tombstone");
    expect(existsSync(f.left)).toBe(false);
  });
  it("hydrates exact durable data and permissions, refreshes a scoped token, checkpoints and restores an evicted guest tree", async () => {
    const f = await fixture();
    mkdirSync(join(f.src, "empty"), { mode: 0o751 });
    mkdirSync(join(f.src, "dist"));
    writeFileSync(join(f.src, "dist", "report"), "sha me", { mode: 0o654 });
    symlinkSync("dist/report", join(f.src, "alias"));
    utimesSync(join(f.src, "dist", "report"), 1112345.123, 1112345.123);
    await publishInitialWorkFolder(f.src, f.store);
    await syncFolder({ path: f.left, grant: { ...f.a, accessToken: "expired", expiresAt: 0 } }, f.state);
    expect(readFileSync(join(f.left, "alias"), "utf8")).toBe("sha me");
    expect(statSync(join(f.left, "empty")).mode & 0o777).toBe(0o751);
    expect(statSync(join(f.left, "dist", "report")).mtimeMs).toBeCloseTo(1112345123, 1);
    writeFileSync(join(f.left, "dist", "report"), "updated");
    await f.syncA();
    rmSync(f.left, { recursive: true });
    await f.syncA();
    expect(readFileSync(join(f.left, "alias"), "utf8")).toBe("updated");
    await f.syncB();
    expect(readFileSync(join(f.right, "dist", "report"), "utf8")).toBe("updated");
    expect(readlinkSync(join(f.right, "alias"))).toBe("dist/report");
  });
  it("merges disjoint writers and preserves conflicting working files and durable history across retries", async () => {
    const f = await fixture();
    writeFileSync(join(f.src, "same"), "base");
    await publishInitialWorkFolder(f.src, f.store);
    await Promise.all([f.syncA(), f.syncB()]);
    writeFileSync(join(f.left, "a"), "left");
    writeFileSync(join(f.right, "b"), "right");
    await Promise.all([f.syncA(), f.syncB()]);
    await f.syncA();
    expect(readFileSync(join(f.left, "b"), "utf8")).toBe("right");
    writeFileSync(join(f.left, "same"), "from-a");
    writeFileSync(join(f.right, "same"), "from-b");
    const winner = await f.syncA();
    await expect(f.syncB()).rejects.toThrow("both");
    await expect(f.syncB()).rejects.toThrow("both");
    expect(readFileSync(join(f.right, "same"), "utf8")).toBe("from-b");
    expect((await f.store.head())?.revision).toBe(winner.revision);
    const gone = await fetch(f.base + "/commit", {
      method: "POST",
      headers: { authorization: "Bearer " + f.owner },
      body: JSON.stringify({ parent: winner.revision, manifest: null }),
    });
    expect(gone.ok).toBe(true);
    await expect(f.syncA()).rejects.toThrow("deleted");
    expect(readFileSync(join(f.left, "same"), "utf8")).toBe("from-a");
  });
  it("keeps original absolute links in their durable history and only exposes confined materializations", async () => {
    const f = await fixture();
    mkdirSync(join(f.src, "d"));
    writeFileSync(join(f.src, "d", "read"), "ok");
    symlinkSync(join(f.src, "d", "read"), join(f.src, "inside"));
    symlinkSync("/etc/hostname", join(f.src, "denied"));
    await publishInitialWorkFolder(f.src, f.store);
    await f.syncA();
    expect(readFileSync(join(f.left, "inside"), "utf8")).toBe("ok");
    expect(() => readFileSync(join(f.left, "denied"))).toThrow();
    expect(readlinkSync(join(f.left, "denied"))).toBe("denied");
    const x = await f.syncA(),
      m = await f.store.tree(x.manifest);
    expect(m.entries.get("inside")).toMatchObject({ target: join(f.src, "d", "read"), scopedTarget: "d/read" });
    expect(m.entries.get("denied")).toMatchObject({ target: "/etc/hostname", scopedTarget: null });
  });
  it("mounts only a separately authorized named project, excludes its alias from loose files, and revokes access without changing original link bytes", async () => {
    const f = await fixture(),
      data = join(f.dir, "data"),
      project = join(data, "reflow"),
      loose = join(data, ".laterdog-owned-work", "visible"),
      task = join(data, ".laterdog", "task-workspaces", "bot", "task");
    const scope = async (path: string, id: string) => ({ path, grant: await f.grant("cmp_alpha", id) });
    const p = await scope(project, "project-" + folderHash(project)),
      l = await scope(loose, "loose"),
      t = await scope(task, "task-test");
    const checkout = (binding: Parameters<typeof syncFolder>[0]) =>
      syncFolder(binding, f.state, undefined, undefined, data);
    const projectSeed = join(f.dir, "project-seed"),
      looseSeed = join(f.dir, "loose-seed");
    mkdirSync(projectSeed);
    mkdirSync(looseSeed);
    mkdirSync(join(projectSeed, "fixtures"));
    writeFileSync(join(projectSeed, "fixtures", "answer"), "project proof");
    const original = join(project, "fixtures", "answer");
    symlinkSync(original, join(f.src, "shared"));
    symlinkSync(join(project, "transient-link", "outside"), join(f.src, "indirect"));
    symlinkSync("/etc/hostname", join(f.src, "system"));
    for (const [path, b] of [
      [f.src, t],
      [projectSeed, p],
      [looseSeed, l],
    ] as const)
      await publishInitialWorkFolder(path, new FolderStore(b.grant, () => {}));
    const enabled = { ...t, linkProjects: [project] };
    await expect(checkout(enabled)).rejects.toThrow("verified checkout");
    await checkout(p);
    writeFileSync(join(f.dir, "outside"), "out of scope");
    symlinkSync(f.dir, join(project, "transient-link"));
    await checkout(t);
    expect(readlinkSync(join(task, "shared"))).toBe("shared");
    const originalRevision = await checkout(enabled);
    expect(readFileSync(join(task, "shared"), "utf8")).toBe("project proof");
    expect(readlinkSync(join(task, "system"))).toBe("system");
    expect(readlinkSync(join(task, "indirect"))).toBe("indirect");
    const disabled = await checkout({ ...t, linkProjects: [] });
    expect(disabled.revision).toBe(originalRevision.revision);
    expect(readlinkSync(join(task, "shared"))).toBe("shared");
    const rm = await new FolderStore(t.grant, () => {}).tree(disabled.manifest);
    expect(rm.entries.get("shared")).toMatchObject({ target: original, scopedTarget: null });
    const aliases = [{ name: "reflow", target: project }];
    await checkout({ ...l, aliases });
    expect(readlinkSync(join(loose, "reflow"))).toBe("../../reflow");
    expect(readFileSync(join(loose, "reflow", "fixtures", "answer"), "utf8")).toBe("project proof");
    writeFileSync(join(loose, "notes"), "owned");
    const flushed = await checkout(l),
      lm = await new FolderStore(l.grant, () => {}).tree(flushed.manifest);
    expect([...lm.entries.keys()]).toEqual(["notes"]);
    await checkout({ ...l, aliases: [] });
    writeFileSync(join(loose, "reflow"), "owned conflicting file");
    await expect(checkout({ ...l, aliases })).rejects.toThrow("conflicts");
    expect(readFileSync(join(loose, "reflow"), "utf8")).toBe("owned conflicting file");
  });
  it("restores a linked set to a single inode, preserves independent identical files, and can split and rejoin its records", async () => {
    const f = await fixture();
    const d = join(f.src, "nested");
    mkdirSync(d);
    const original = join(f.src, "a"),
      outside = join(f.dir, "outside-link");
    writeFileSync(original, "linked");
    linkSync(original, join(d, "b"));
    linkSync(original, join(d, "c"));
    linkSync(original, outside);
    writeFileSync(join(f.src, "other"), "linked");
    const head = await publishInitialWorkFolder(f.src, f.store);
    const manifest = await f.store.tree(head.manifest!);
    expect(manifest.entries.get("nested/b")).toMatchObject({ hardlink: "a" });
    expect(manifest.entries.get("other")).not.toHaveProperty("hardlink");
    await f.syncA();
    const inode = (base: string, path: string) => statSync(join(base, path)).ino;
    expect(inode(f.left, "a")).toBe(inode(f.left, "nested/c"));
    expect(statSync(join(f.left, "a")).nlink).toBe(3);
    expect(inode(f.left, "a")).not.toBe(inode(f.left, "other"));
    writeFileSync(join(f.left, "nested/b"), "new-content");
    await f.syncA();
    await f.syncB();
    expect(readFileSync(join(f.right, "a"), "utf8")).toBe("new-content");
    expect(inode(f.right, "a")).toBe(inode(f.right, "nested/b"));
    rmSync(join(f.left, "nested/b"));
    writeFileSync(join(f.left, "nested/b"), "new-content");
    await f.syncA();
    await f.syncB();
    expect(inode(f.right, "nested/b")).not.toBe(inode(f.right, "a"));
    rmSync(join(f.left, "nested/b"));
    linkSync(join(f.left, "a"), join(f.left, "nested/b"));
    await f.syncA();
    await f.syncB();
    expect(inode(f.right, "nested/b")).toBe(inode(f.right, "a"));
    const tip = await f.store.head(),
      tree = await f.store.tree(tip!.manifest!);
    const b = tree.entries.get("nested/b");
    if (b?.kind !== "file") throw Error("Fixture missing file");
    b.sha256 = "f".repeat(64);
    expect(await f.store.publish(tree, tip!.revision)).toBeTruthy();
    await expect(f.syncB()).rejects.toThrow("hard link");
    expect(inode(f.right, "a")).toBe(inode(f.right, "nested/b"));
  });
  it("refuses a branch whose remote file bytes do not match the published hash, preserving the resident copy", async () => {
    const f = await fixture();
    writeFileSync(join(f.src, "out"), "old");
    await publishInitialWorkFolder(f.src, f.store);
    await f.syncA();
    await f.syncB();
    writeFileSync(join(f.left, "out"), "changed");
    const x = await f.syncA();
    const remote = await f.store.tree(x.manifest);
    const entry = remote.entries.get("out");
    if (entry?.kind !== "file") throw Error("No file");
    const id = (await f.store.leaves(entry.contents, "chunks").next()).value;
    const k = [...f.objects.keys()].find((v) => v.endsWith("/blobs/" + id));
    if (!k) throw Error("No chunk");
    f.objects.get(k)!.bytes = Buffer.from("invalid");
    await expect(f.syncB()).rejects.toThrow("checksum");
    expect(readFileSync(join(f.right, "out"), "utf8")).toBe("old");
  });
});
