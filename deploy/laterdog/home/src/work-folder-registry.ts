import { hex, sha256 } from "./encoding.ts";
import type { WorkFolderBucket } from "./work-folder-store.ts";

interface Registry {
  page: string | null;
  fence?: string;
}

interface Page {
  scopes: string[];
  previous: string | null;
}

async function read<T>(bucket: WorkFolderBucket, key: string): Promise<{ value: T; etag: string } | null> {
  const obj = await bucket.get(key);
  return obj ? { value: await new Response(obj.body).json() as T, etag: obj.etag } : null;
}

async function pageAt(bucket: WorkFolderBucket, prefix: string, page: string | null): Promise<Page> {
  if (page === null) return { scopes: [], previous: null };
  const data = await bucket.get(prefix + "scope-pages/" + page);
  if (!data) throw new Error("Missing working folder registry page");
  const bytes = new Uint8Array(await new Response(data.body).arrayBuffer());
  if (hex(await sha256(bytes)) !== page) throw new Error("Working folder registry checksum differs");
  return JSON.parse(new TextDecoder().decode(bytes)) as Page;
}

export async function registerFolder(bucket: WorkFolderBucket, prefix: string, scope: string): Promise<boolean> {
  const marker = prefix + "scope-index/" + scope;
  if (await bucket.head(marker)) return true;
  for (;;) {
    const registry = await read<Registry>(bucket, prefix + "registry");
    if (registry?.value.fence) return false;
    const old = registry?.value.page ?? null;
    const page = await pageAt(bucket, prefix, old);
    const next: Page = page.scopes.length < 64 ? { scopes: [...new Set([...page.scopes, scope])], previous: page.previous } : { scopes: [scope], previous: old };
    const bytes = JSON.stringify(next);
    const id = hex(await sha256(bytes));
    await bucket.put(prefix + "scope-pages/" + id, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
    const updated = await bucket.put(prefix + "registry", JSON.stringify({ page: id }), { onlyIf: registry ? { etagMatches: registry.etag } : { etagDoesNotMatch: "*" } });
    if (updated) {
      await bucket.put(marker, "1", { onlyIf: { etagDoesNotMatch: "*" } });
      return true;
    }
  }
}

export async function registeredPage(bucket: WorkFolderBucket, prefix: string, cursor: string | null) {
  const registry = (await read<Registry>(bucket, prefix + "registry"))?.value ?? { page: null };
  const page = await pageAt(bucket, prefix, cursor ?? registry.page);
  return { scopes: page.scopes, cursor: page.previous, revision: registry.page, fence: registry.fence ?? null };
}

export async function registryFence(bucket: WorkFolderBucket, prefix: string, body: { revision: string | null; fence: string }, release: boolean): Promise<boolean> {
  const key = prefix + "registry", old = await read<Registry>(bucket, key);
  if ((old?.value.page ?? null) !== body.revision || old?.value.fence && old.value.fence !== body.fence) return false;
  if (release ? !old?.value.fence : old?.value.fence === body.fence) return true;
  const next: Registry = release ? { page: body.revision } : { page: body.revision, fence: body.fence };
  return Boolean(await bucket.put(key, JSON.stringify(next), { onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: "*" } }));
}

export async function verifiedMembership(bucket: WorkFolderBucket, prefix: string, scopes: string[], fence: string): Promise<boolean> {
  const registry = await read<Registry>(bucket, prefix + "registry");
  if (registry?.value.fence !== fence) return false;
  const registered = new Set<string>();
  let cursor = registry.value.page;
  while (cursor) {
    const page = await pageAt(bucket, prefix, cursor);
    for (const s of page.scopes) registered.add(s);
    cursor = page.previous;
  }
  return registered.size === scopes.length && scopes.every(scope => registered.has(scope));
}
