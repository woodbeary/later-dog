import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { guardBody, json, parsedBodyOf, readBody } from "./http.ts";

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

async function served(handle: (res: ServerResponse) => void): Promise<{ status: number; body: string } | "cut off"> {
  const server = createServer((_req, res) => handle(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    return { status: response.status, body: await response.text() };
  } catch {
    return "cut off";
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("json", () => {
  it("keeps the first answer when a late failure tries to answer again", async () => {
    let late: unknown;
    const reply = await served((res) => {
      json(res, 200, { ok: true });
      try {
        json(res, 500, { error: "late" });
      } catch (error) {
        late = error;
      }
    });
    expect(late).toBeUndefined();
    expect(reply).toEqual({ status: 200, body: JSON.stringify({ ok: true }) });
  });

  it("cuts off a response that was already streaming instead of throwing", async () => {
    let late: unknown;
    const reply = await served((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      try {
        json(res, 500, { error: "late" });
      } catch (error) {
        late = error;
        res.end();
      }
    });
    expect(late).toBeUndefined();
    expect(reply).toBe("cut off");
  });
});
