import { describe, expect, it } from "vitest";
import { authorizedState, forgetHomeState, handleState, stateKey, type StateBucket } from "../src/state.ts";

const CONTAINER = "a".repeat(64);

function memoryBucket(): StateBucket & { objects: Map<string, ArrayBuffer> } {
  const objects = new Map<string, ArrayBuffer>();
  return {
    objects,
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: new Response(value).body as ReadableStream, httpEtag: '"etag"' } : null;
    },
    async put(key, value) {
      objects.set(key, value);
      return {};
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

describe("home state store", () => {
  it("keeps each home under its own prefix", () => {
    expect(stateKey(CONTAINER, "http://state.r2/manifest.json")).toBe(`homes/${CONTAINER}/manifest.json`);
    expect(stateKey(CONTAINER, `http://state.r2/blobs/${"b".repeat(64)}`)).toBe(`homes/${CONTAINER}/blobs/${"b".repeat(64)}`);
    expect(stateKey(CONTAINER, "http://state.r2/../other/manifest.json")).toBeNull();
    expect(stateKey(CONTAINER, "http://state.r2/blobs/not-a-hash")).toBeNull();
  });

  it("stores and serves objects, and forgets a whole home", async () => {
    const bucket = memoryBucket();
    const put = await handleState(new Request("http://state.r2/manifest.json", { method: "PUT", body: "{}" }), bucket, CONTAINER);
    expect(put.status).toBe(201);
    const got = await handleState(new Request("http://state.r2/manifest.json"), bucket, CONTAINER);
    expect(await got.text()).toBe("{}");
    expect((await handleState(new Request("http://state.r2/manifest.json"), bucket, "c".repeat(64))).status).toBe(404);
    bucket.objects.set(`homes/${"c".repeat(64)}/manifest.json`, new ArrayBuffer(1));
    expect(await forgetHomeState(bucket, CONTAINER)).toBe(1);
    expect(bucket.objects.has(`homes/${"c".repeat(64)}/manifest.json`)).toBe(true);
  });

  it("answers only the home's own sync token", async () => {
    const token = "token-of-this-home";
    expect(await authorizedState(new Request("http://state.r2/manifest.json", { headers: { authorization: `Bearer ${token}` } }), token)).toBe(true);
    expect(await authorizedState(new Request("http://state.r2/manifest.json", { headers: { authorization: "Bearer guess" } }), token)).toBe(false);
    expect(await authorizedState(new Request("http://state.r2/manifest.json"), token)).toBe(false);
    expect(await authorizedState(new Request("http://state.r2/manifest.json", { headers: { authorization: `Bearer ${token}` } }), undefined)).toBe(false);
  });
});

describe("cleaning up a home's saved pieces", () => {
  it("lists only this home's pieces and deletes pieces, never the manifest", async () => {
    const bucket = memoryBucket();
    const other = "b".repeat(64);
    const hash = "c".repeat(64);
    bucket.objects.set(`homes/${CONTAINER}/blobs/${hash}`, new ArrayBuffer(1));
    bucket.objects.set(`homes/${CONTAINER}/manifest.json`, new ArrayBuffer(1));
    bucket.objects.set(`homes/${other}/blobs/${"d".repeat(64)}`, new ArrayBuffer(1));
    const listed = await handleState(new Request("http://state.r2/blobs/"), bucket, CONTAINER);
    expect(await listed.json()).toEqual({ hashes: [hash] });
    expect((await handleState(new Request("http://state.r2/manifest.json", { method: "DELETE" }), bucket, CONTAINER)).status).toBe(405);
    expect(bucket.objects.has(`homes/${CONTAINER}/manifest.json`)).toBe(true);
    expect((await handleState(new Request(`http://state.r2/blobs/${hash}`, { method: "DELETE" }), bucket, CONTAINER)).status).toBe(204);
    expect(bucket.objects.has(`homes/${CONTAINER}/blobs/${hash}`)).toBe(false);
    expect(bucket.objects.has(`homes/${other}/blobs/${"d".repeat(64)}`)).toBe(true);
    expect((await handleState(new Request("http://state.r2/blobs/../manifest.json", { method: "DELETE" }), bucket, CONTAINER)).status).toBe(405);
    expect(bucket.objects.has(`homes/${CONTAINER}/manifest.json`)).toBe(true);
  });
});
