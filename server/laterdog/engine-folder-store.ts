import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  WORK_FOLDER_BLOB_BYTES,
  WORK_FOLDER_PAGE_SIZE,
  compareWorkFolderPaths,
  safeWorkFolderPath,
  materializedWorkFolderLink,
  type WorkFolderEntry,
  type WorkFolderGrant,
  type WorkFolderHead,
  type WorkFolderNode,
} from "../../shared/work-folder-store.ts";

export type FolderTree = { mode: number; mtimeMs?: number; entries: Map<string, WorkFolderEntry> };
type Category = "entries" | "chunks";
export const folderHash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const validFolderHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validMode = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o7777;

function checkedEntry(entry: WorkFolderEntry): WorkFolderEntry {
  if (entry && safeWorkFolderPath(entry.path)) {
    if (entry.kind === "dir" && validMode(entry.mode)) return entry;
    if (entry.kind === "link") {
      materializedWorkFolderLink(entry);
      return entry;
    }
    if (
      entry.kind === "file" &&
      validMode(entry.mode) &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0 &&
      validFolderHash(entry.sha256) &&
      validFolderHash(entry.contents)
    )
      return entry;
  }
  throw new Error("Invalid working folder manifest entry");
}

export abstract class FolderTreeReader {
  protected readonly cachedPages = new Map<string, WorkFolderNode>();
  abstract read(kind: "manifests" | "blobs", hash: string): Promise<Buffer>;
  async #page(hash: string): Promise<WorkFolderNode> {
    let page = this.cachedPages.get(hash);
    if (!page) {
      page = JSON.parse((await this.read("manifests", hash)).toString()) as WorkFolderNode;
      if (!page || page.v !== 1) throw new Error("Invalid working folder object version");
      this.cachedPages.set(hash, page);
    }
    return page;
  }

  async *leaves(hash: string, of: Category, depth = 0): AsyncGenerator<WorkFolderEntry | string> {
    const page = await this.#page(hash);
    if (depth > 64) throw new Error("Working folder manifest nesting is invalid");
    if (
      page.kind === "pages" &&
      page.of === of &&
      Array.isArray(page.children) &&
      page.children.length > 0 &&
      page.children.length <= WORK_FOLDER_PAGE_SIZE &&
      page.children.every(validFolderHash)
    ) {
      for (const id of page.children) yield* this.leaves(id, of, depth + 1);
    } else if (
      of === "entries" &&
      page.kind === "entries" &&
      Array.isArray(page.entries) &&
      page.entries.length <= WORK_FOLDER_PAGE_SIZE
    ) {
      for (const entry of page.entries) yield checkedEntry(entry);
    } else if (
      of === "chunks" &&
      page.kind === "chunks" &&
      Array.isArray(page.hashes) &&
      page.hashes.length <= WORK_FOLDER_PAGE_SIZE &&
      page.hashes.every(validFolderHash)
    ) {
      yield* page.hashes;
    } else throw new Error("Working folder manifest page has an unexpected shape");
  }

  async tree(manifest: string): Promise<FolderTree> {
    const root = await this.#page(manifest);
    if (root.kind !== "root" || !validMode(root.mode) || !validFolderHash(root.entries))
      throw new Error("Invalid working folder root");
    const entries = new Map<string, WorkFolderEntry>();
    let previous = "";
    for await (const value of this.leaves(root.entries, "entries")) {
      const e = value as WorkFolderEntry;
      if (compareWorkFolderPaths(previous, e.path) >= 0)
        throw new Error("Working folder paths are duplicated or unordered");
      const slash = e.path.lastIndexOf("/");
      if (slash !== -1 && entries.get(e.path.slice(0, slash))?.kind !== "dir")
        throw new Error("Missing working folder parent directory");
      previous = e.path;
      entries.set(e.path, e);
    }
    return { mode: root.mode, mtimeMs: root.mtimeMs, entries };
  }

}

export class FolderStore extends FolderTreeReader {
  #refreshing?: Promise<void>;
  #publishRouteMissing = false;
  readonly progress: () => void;
  grant: WorkFolderGrant;
  readonly #renewed: (grant: WorkFolderGrant) => void;
  readonly #signal?: AbortSignal;
  constructor(
    grant: WorkFolderGrant,
    renewed: (grant: WorkFolderGrant) => void,
    signal?: AbortSignal,
    progress = () => {},
  ) {
    super();
    this.progress = progress;
    this.#renewed = renewed;
    this.#signal = signal;
    this.grant = grant;
    const url = new URL(grant.baseUrl);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !/^\/api\/work-folders\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      throw new Error("Invalid working folder capability origin");
  }

  async #renew(): Promise<void> {
    if (!this.#refreshing)
      this.#refreshing = (async () => {
        const prior = this.grant;
        const res = await fetch(prior.baseUrl + "/refresh", {
          method: "POST",
          redirect: "error",
          headers: { authorization: "Bearer " + prior.refreshToken },
          signal: this.#deadline(),
        });
        if (!res.ok) throw new Error(`Working folder access renewal returned ${res.status}`);
        const next = (await res.json()) as WorkFolderGrant;
        if (
          next.baseUrl !== prior.baseUrl ||
          next.guestId !== prior.guestId ||
          !next.accessToken ||
          !next.refreshToken ||
          !(next.expiresAt > Date.now())
        )
          throw new Error("Working folder access renewal changed its assignment");
        this.#renewed(next);
        this.grant = next;
      })().finally(() => {
        this.#refreshing = undefined;
      });
    return this.#refreshing;
  }

  #deadline(): AbortSignal {
    return this.#signal ? AbortSignal.any([this.#signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  }

  async #request(path: string, method = "GET", body?: Uint8Array | string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      this.progress();
      if (this.grant.expiresAt < Date.now() + 30_000) await this.#renew();
      let response: Response | undefined;
      try {
        response = await fetch(this.grant.baseUrl + path, {
          method,
          ...(body !== undefined ? {body: body as NonNullable<Parameters<typeof fetch>[1]>["body"]} : {}),
          headers: {
            authorization: "Bearer " + this.grant.accessToken,
            ...(body
              ? { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream" }
              : {}),
          },
          redirect: "error",
          signal: this.#deadline(),
        });
      } catch (err) {
        if (attempt >= 2 || this.#signal?.aborted) throw err;
      }
      if (response && response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        await this.#renew();
        continue;
      }
      if (response && ((response.status < 500 && response.status !== 429) || attempt >= 2)) return response;
      await response?.body?.cancel();
      await delay(250 * (attempt + 1), undefined, { signal: this.#signal });
    }
  }

  async head(): Promise<WorkFolderHead | null> {
    const r = await this.#request("/head");
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Working folder head returned ${r.status}`);
    const h = (await r.json()) as WorkFolderHead;
    if (
      !h.revision ||
      !((h.state === "live" && validFolderHash(h.manifest)) || (h.state === "tombstone" && h.manifest === null))
    )
      throw new Error("Invalid working folder head");
    return h;
  }

  async read(kind: "manifests" | "blobs", hash: string): Promise<Buffer> {
    if (!validFolderHash(hash)) throw new Error("Invalid working folder object identity");
    const r = await this.#request("/" + kind + "/" + hash);
    if (!r.ok) throw new Error(`Reading a working folder object returned ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > WORK_FOLDER_BLOB_BYTES || folderHash(bytes) !== hash)
      throw new Error("Working folder object checksum mismatch");
    return bytes;
  }

  async put(kind: "manifests" | "blobs", bytes: Buffer): Promise<string> {
    const hash = folderHash(bytes);
    if (kind === "blobs") {
      const present = await this.#request("/blobs/" + hash, "HEAD");
      if (present.ok) return hash;
      if (present.status !== 404) throw new Error(`Checking working folder content returned ${present.status}`);
    }
    const r = await this.#request("/" + kind + "/" + hash, "PUT", bytes);
    if (!r.ok) throw new Error(`Writing a working folder object returned ${r.status}`);
    return hash;
  }

  async #putPage(node: WorkFolderNode): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(node)),
      hash = folderHash(bytes);
    if (!this.cachedPages.has(hash)) {
      await this.put("manifests", bytes);
      this.cachedPages.set(hash, node);
    }
    return hash;
  }

  async pages(of: Category, items: string[] | WorkFolderEntry[]): Promise<string> {
    return folderManifestPages(of, items, node => this.#putPage(node));
  }

  async removeEmpty(head: WorkFolderHead): Promise<void> {
    if (head.state === "tombstone") return;
    const range = await this.#request("/ranges/" + head.manifest);
    if (!range.ok) throw new Error("Could not read the directory before removing it");
    const page = await range.json() as { self: { of: string; count: number } };
    if (page.self.of !== "root" || page.self.count !== 0) throw Object.assign(new Error("Folder contains files"), { code: "ENOTEMPTY" });
    const result = await this.#request("/commit", "POST", JSON.stringify({ parent: head.revision, manifest: null }));
    if (!result.ok || (await this.head())?.state !== "tombstone") throw Object.assign(new Error("Folder changed during removal"), { code: "EBUSY" });
  }

  async publish(tree: FolderTree, parent: string | null): Promise<WorkFolderHead | null> {
    if (!this.#publishRouteMissing) {
      const fresh: { sha256: string; json: string; node: WorkFolderNode }[] = [];
      const collect = async (node: WorkFolderNode) => {
        const json = JSON.stringify(node), hash = folderHash(json);
        if (!this.cachedPages.has(hash) && !fresh.some((page) => page.sha256 === hash)) fresh.push({ sha256: hash, json, node });
        return hash;
      };
      const entries = await folderManifestPages("entries", [...tree.entries.values()].sort((a, b) => compareWorkFolderPaths(a.path, b.path)), collect);
      const manifest = await collect({ v: 1, kind: "root", mode: tree.mode, ...(tree.mtimeMs === undefined ? {} : { mtimeMs: tree.mtimeMs }), entries });
      const body = JSON.stringify({ parent, manifest, pages: fresh.map(({ sha256, json }) => ({ sha256, json })) });
      if (fresh.length <= PUBLISH_PAGES && Buffer.byteLength(body) <= WORK_FOLDER_BLOB_BYTES) {
        const res = await this.#request("/publish", "POST", body);
        if (res.status === 404) {
          await res.body?.cancel();
          this.#publishRouteMissing = true;
        } else {
          if (res.status !== 409 && !res.ok) throw new Error(`Publishing working folder returned ${res.status}`);
          for (const page of fresh) this.cachedPages.set(page.sha256, page.node);
          if (res.status === 409) {
            await res.body?.cancel();
            return null;
          }
          const head = (await res.json()) as WorkFolderHead;
          return head?.manifest === manifest && typeof head.revision === "string" ? head : null;
        }
      }
    }
    const entries = await this.pages(
      "entries",
      [...tree.entries.values()].sort((a, b) => compareWorkFolderPaths(a.path, b.path)),
    );
    const manifest = await this.#putPage({
      v: 1,
      kind: "root",
      mode: tree.mode,
      ...(tree.mtimeMs === undefined ? {} : { mtimeMs: tree.mtimeMs }),
      entries,
    });
    const res = await this.#request("/commit", "POST", JSON.stringify({ parent, manifest }));
    if (res.status !== 409 && !res.ok) throw new Error(`Publishing working folder returned ${res.status}`);
    const head = await this.head();
    return head?.manifest === manifest ? head : null;
  }
}

const PUBLISH_PAGES = 256;

export async function folderManifestPages(of: Category, items: string[] | WorkFolderEntry[], putPage: (node:WorkFolderNode) => Promise<string>): Promise<string> {
    let pending: string[] = [];
    for (let n = 0; n < Math.max(1, items.length); n += WORK_FOLDER_PAGE_SIZE) {
      pending.push(
        await putPage(
          of === "chunks"
            ? { v: 1, kind: "chunks", hashes: items.slice(n, n + WORK_FOLDER_PAGE_SIZE) as string[] }
            : { v: 1, kind: "entries", entries: items.slice(n, n + WORK_FOLDER_PAGE_SIZE) as WorkFolderEntry[] },
        ),
      );
    }
    while (pending.length > 1) {
      const upper: string[] = [];
      for (let n = 0; n < pending.length; n += WORK_FOLDER_PAGE_SIZE)
        upper.push(
          await putPage({ v: 1, kind: "pages", of, children: pending.slice(n, n + WORK_FOLDER_PAGE_SIZE) }),
        );
      pending = upper;
    }
    return pending[0];
}
