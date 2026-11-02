import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createVoiceStreams } from "../laterdog/voice-stream.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createVoiceStreamRoutes, VOICE_STREAM_TYPE } from "./voice-stream.ts";
import { PASS, type RouteContext } from "./table.ts";

const OWN = { token: "sk_own_voice", api: "https://elevenlabs.example/v1", included: false };

function context(method: string, query: string, body = new Uint8Array(800), type = VOICE_STREAM_TYPE) {
  const headers: Record<string, string> = {};
  const sent: { status: number; body: unknown }[] = [];
  const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { "content-type": type } }) as unknown as IncomingMessage;
  const ctx = {
    req,
    res: { setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as ServerResponse,
    url: new URL(`http://localhost/api/voice/stream${query}`),
    path: "/api/voice/stream",
    method,
    auth: {} as RequestAuth,
    json: ((_res: ServerResponse, status: number, value: unknown) => { sent.push({ status, body: value }); }) as RouteContext["json"],
    readBody: (async () => "") as unknown as RouteContext["readBody"],
  } satisfies RouteContext;
  return { ctx, headers, sent };
}

describe("voice stream route", () => {
  it("takes parts while you talk and answers the last one with the text and its timings", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => Response.json({ text: " Book the table. " }));
    const route = createVoiceStreamRoutes({ streams: createVoiceStreams(), enabled: () => true, transcriber: () => OWN, fetcher });
    const first = context("POST", "?id=dictation-abc&seq=0");
    await route(first.ctx);
    expect(first.sent).toEqual([{ status: 200, body: { ok: true } }]);
    const last = context("POST", "?id=dictation-abc&seq=1&final=1&language=en");
    await route(last.ctx);
    expect(last.sent).toEqual([{ status: 200, body: { text: "Book the table.", pieces: 1, included: false } }]);
    expect(last.headers["server-timing"]).toMatch(/^read;dur=\d+, wait;dur=\d+, tail;dur=\d+$/);
    expect(info.mock.calls[0]![0]).toMatch(/^\[voice\] streamed dictation in 1 pieces/);
    info.mockRestore();
  });

  it("refuses what it can't use and leaves other paths alone", async () => {
    const route = createVoiceStreamRoutes({ streams: createVoiceStreams(), enabled: () => true, transcriber: () => OWN });
    const wrongType = context("POST", "?id=dictation-abc&seq=0", new Uint8Array(4), "audio/wav");
    await route(wrongType.ctx);
    expect(wrongType.sent[0]!.status).toBe(415);
    const noId = context("POST", "?seq=0");
    await route(noId.ctx);
    expect(noId.sent[0]!.status).toBe(400);
    const off = context("POST", "?id=dictation-abc&seq=0");
    await createVoiceStreamRoutes({ streams: createVoiceStreams(), enabled: () => false, transcriber: () => OWN })(off.ctx);
    expect(off.sent[0]).toEqual({ status: 409, body: { error: "Sharper dictation is turned off.", reason: "off" } });
    const other = context("GET", "?id=dictation-abc");
    expect(await route(other.ctx)).toBe(PASS);
  });

  it("drops a dictation you threw away", async () => {
    const streams = createVoiceStreams();
    const route = createVoiceStreamRoutes({ streams, enabled: () => true, transcriber: () => OWN });
    await route(context("POST", "?id=dictation-abc&seq=0").ctx);
    expect(streams.size()).toBe(1);
    const dropped = context("DELETE", "?id=dictation-abc");
    await route(dropped.ctx);
    expect(dropped.sent).toEqual([{ status: 200, body: { ok: true } }]);
    expect(streams.size()).toBe(0);
  });
});
