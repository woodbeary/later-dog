import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { guardBody, parsedBodyOf, readBody } from "./http.ts";

const request = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

function splitInsideCharacter(bytes: Buffer, from: number): [Buffer, Buffer] {
  let cut = from;
  while ((bytes[cut]! & 0xc0) !== 0x80) cut += 1;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

describe("readBody", () => {
  it("keeps a character whole when a chunk boundary splits it", async () => {
    const text = "مرحبا بالعالم 中文 😀 ".repeat(50);
    const bytes = Buffer.from(JSON.stringify({ text }));
    const body = await readBody(request(splitInsideCharacter(bytes, 100)));
    expect(body.text).toBe(text);
  });

  it("keeps every character whole across many small chunks", async () => {
    const text = "مرحبا 中文 😀".repeat(20);
    const bytes = Buffer.from(JSON.stringify({ text }));
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 7) chunks.push(bytes.subarray(at, at + 7));
    const body = await readBody(request(chunks));
    expect(body.text).toBe(text);
  });

  it("still refuses a body over the limit", async () => {
    const bytes = Buffer.from(JSON.stringify({ text: "中".repeat(100) }));
    await expect(readBody(request(splitInsideCharacter(bytes, 10)), 64)).rejects.toMatchObject({ status: 413 });
  });
});

describe("guardBody", () => {
  it("lets a guarded request through when the guard has no objection", async () => {
    const req = request([Buffer.from(JSON.stringify({ name: "Scout" }))]);
    guardBody(req, () => null);
    expect(await readBody(req)).toEqual({ name: "Scout" });
  });

  it("refuses with 403 and the guard's own words, and keeps the refused body unparsed", async () => {
    const req = request([Buffer.from(JSON.stringify({ approvalMode: "full" }))]);
    guardBody(req, (body) => (body as { approvalMode?: string }).approvalMode === "full" ? "Needs the desktop app." : null);
    await expect(readBody(req)).rejects.toMatchObject({ status: 403, message: "Needs the desktop app." });
    expect(parsedBodyOf(req)).toBeUndefined();
  });

  it("guards only the request it was set on", async () => {
    const guarded = request([Buffer.from("{}")]);
    guardBody(guarded, () => "no");
    const other = request([Buffer.from("{}")]);
    await expect(readBody(guarded)).rejects.toMatchObject({ status: 403 });
    expect(await readBody(other)).toEqual({});
  });
});
