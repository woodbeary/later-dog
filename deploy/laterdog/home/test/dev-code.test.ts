import { describe, expect, it } from "vitest";
import { devCodeKey, devCodeOn, handleDevCode } from "../src/dev-code.ts";
import type { StateBucket } from "../src/state.ts";

const HASH = "b".repeat(64);

function bucket(objects: Record<string, string>): StateBucket {
  return {
    async head(key) { return key in objects ? {} : null; },
    async get(key) { return key in objects ? { body: new Response(objects[key]).body as ReadableStream, httpEtag: '"e"' } : null; },
    async put() { throw new Error("dev code is never written from a home"); },
    async delete() { throw new Error("dev code is never deleted from a home"); },
    async list() { return { objects: [], truncated: false }; },
  };
}

describe("server code pushed to test homes", () => {
  it("is on only when the deploy says 1", () => {
    expect(devCodeOn("1")).toBe(true);
    expect(devCodeOn("")).toBe(false);
    expect(devCodeOn(undefined)).toBe(false);
  });

  it("reads the shared pointer and bundles, and nothing else", () => {
    expect(devCodeKey("http://state.r2/dev-code.json")).toBe("dev-code/current.json");
    expect(devCodeKey(`http://state.r2/dev-code/${HASH}.tgz`)).toBe(`dev-code/${HASH}.tgz`);
    expect(devCodeKey("http://state.r2/manifest.json")).toBeNull();
    expect(devCodeKey("http://state.r2/dev-code/../manifest.json")).toBeNull();
  });

  it("serves the pointer, refuses writes and leaves other paths to the state store", async () => {
    const store = bucket({ "dev-code/current.json": JSON.stringify({ hash: HASH }) });
    const pointer = await handleDevCode(new Request("http://state.r2/dev-code.json"), store);
    expect(await pointer?.json()).toEqual({ hash: HASH });
    expect((await handleDevCode(new Request("http://state.r2/dev-code.json", { method: "PUT", body: "{}" }), store))?.status).toBe(405);
    expect((await handleDevCode(new Request(`http://state.r2/dev-code/${HASH}.tgz`), store))?.status).toBe(404);
    expect(await handleDevCode(new Request("http://state.r2/manifest.json"), store)).toBeNull();
  });
});
