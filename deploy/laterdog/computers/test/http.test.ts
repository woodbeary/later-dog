import { describe, expect, it } from "vitest";
import { TooLarge, apiError, collect, outputText, readLimited, within } from "../src/http";

function streamOf(chunks: Uint8Array[], { close = true } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("apiError", () => {
  it("answers { error: { code, message } } with the status", async () => {
    const response = apiError({ status: 409, code: "asleep", message: "Wake it first." });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ error: { code: "asleep", message: "Wake it first." } });
  });
});

describe("readLimited", () => {
  it("reads a body within the limit", async () => {
    expect(new TextDecoder().decode(await readLimited(streamOf([bytes("hello "), bytes("world")]), 11))).toBe("hello world");
    expect(await readLimited(null, 10)).toEqual(new Uint8Array(0));
  });
  it("refuses a body past the limit", async () => {
    await expect(readLimited(streamOf([bytes("hello "), bytes("world")]), 10)).rejects.toBeInstanceOf(TooLarge);
  });
});

describe("within", () => {
  it("returns the value or undefined after the deadline", async () => {
    expect(await within(Promise.resolve(5), 50)).toBe(5);
    expect(await within(new Promise(() => {}), 10)).toBeUndefined();
  });
});

describe("collect", () => {
  it("keeps everything under the cap", async () => {
    const collected = await collect(streamOf([bytes("abc"), bytes("def")]), 100).settle(100);
    expect(collected).toMatchObject({ total: 6, ended: true });
    expect(outputText(collected)).toBe("abcdef");
  });

  it("drains past the cap and says how much was dropped", async () => {
    const collected = await collect(streamOf([bytes("abc"), bytes("defgh"), bytes("ij")]), 4).settle(100);
    expect(collected.total).toBe(10);
    expect(new TextDecoder().decode(collected.bytes)).toBe("abcd");
    expect(outputText(collected)).toBe("abcd\n[later.dog: output truncated; kept the first 4 of 10 bytes]");
  });

  it("stops waiting for a stream a background process keeps open", async () => {
    const started = Date.now();
    const collected = await collect(streamOf([bytes("started")], { close: false }), 100).settle(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(collected).toMatchObject({ total: 7, ended: false });
    expect(outputText(collected)).toBe("started");
  });

  it("treats a missing stream as empty", async () => {
    expect(await collect(null, 10).settle(10)).toEqual({ bytes: new Uint8Array(0), total: 0, ended: true });
  });

  it("decodes invalid UTF-8 without throwing", () => {
    expect(outputText({ bytes: Uint8Array.of(0x61, 0xff, 0x62), total: 3, ended: true })).toBe("a�b");
  });
});
