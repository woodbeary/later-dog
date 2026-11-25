import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { measureFixtureResponse } from "./desktop-home-http.ts";

let server: Server | undefined;

async function serve(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => {
    if (server) server.close(() => done());
    else done();
  });
  server = undefined;
});

describe("fixture HTTP timing", () => {
  it("waits for the complete body and records headers separately", async () => {
    let release = () => {};
    let sent = () => {};
    const headers = new Promise<void>((done) => {
      sent = done;
    });
    const url = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"text":"');
      release = () => response.end('hello 🐕"}');
      sent();
    });
    let completed = false;
    const pending = measureFixtureResponse(`${url}/api/health`).then((value) => {
      completed = true;
      return value;
    });
    await headers;
    await new Promise<void>((done) => setImmediate(done));
    expect(completed).toBe(false);
    release();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.bytes).toBe(Buffer.byteLength('{"text":"hello 🐕"}'));
    expect(result.responseHeadersMs).toBeGreaterThanOrEqual(0);
    expect(result.bodyCompleteMs).toBeGreaterThanOrEqual(result.responseHeadersMs);
  });

  it("fails a run when a fixture endpoint does not succeed", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(503);
      response.end("unavailable");
    });
    await expect(measureFixtureResponse(`${url}/api/health`)).rejects.toThrow(
      "fixture HTTP /api/health: 503",
    );
  });

  it("does not follow a redirect out of the measured endpoint", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(302, { location: "/api/other" });
      response.end();
    });
    await expect(measureFixtureResponse(`${url}/api/health`)).rejects.toThrow();
  });

  it.each([
    "https://example.com/api/health",
    "http://example.com/api/health",
    "http://127.0.0.1/not-an-api",
    "http://name:password@127.0.0.1/api/health",
  ])("refuses a target outside the isolated fixture API: %s", async (url) => {
    await expect(measureFixtureResponse(url)).rejects.toThrow("isolated loopback fixture API");
  });
});
