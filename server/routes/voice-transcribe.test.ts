import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { RequestAuth } from "../request-auth.ts";
import { createVoiceTranscribeRoutes } from "./voice-transcribe.ts";
import type { RouteContext } from "./table.ts";

function context() {
  const headers: Record<string, string> = {};
  const sent: { status: number; body: unknown }[] = [];
  const ctx = {
    req: { headers: { "content-length": "480044" } } as unknown as IncomingMessage,
    res: { setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as ServerResponse,
    url: new URL("http://localhost/api/voice/transcribe"),
    path: "/api/voice/transcribe",
    method: "POST",
    auth: {} as RequestAuth,
    json: ((_res: ServerResponse, status: number, body: unknown) => { sent.push({ status, body }); }) as RouteContext["json"],
    readBody: (async () => "") as unknown as RouteContext["readBody"],
  } satisfies RouteContext;
  return { ctx, headers, sent };
}

describe("voice transcribe route", () => {
  it("answers with the text and says where the time went", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { ctx, headers, sent } = context();
    const route = createVoiceTranscribeRoutes({ transcribe: async () => ({ status: 200, body: { text: "hi" }, timings: { readMs: 120, serviceMs: 830 } }) });
    await route(ctx);
    expect(sent).toEqual([{ status: 200, body: { text: "hi" } }]);
    expect(headers["server-timing"]).toBe("read;dur=120, service;dur=830");
    expect(info).toHaveBeenCalledWith("[voice] transcribed 480044 bytes: read 120 ms, service 830 ms, answered 200");
    info.mockRestore();
  });
});
