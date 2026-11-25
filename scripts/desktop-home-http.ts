export interface HttpTiming {
  status: number;
  bytes: number;
  responseHeadersMs: number;
  bodyCompleteMs: number;
}

export async function measureFixtureResponse(address: string): Promise<HttpTiming> {
  const url = new URL(address);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.startsWith("/api/") || url.username || url.password) {
    throw new Error("HTTP measurements require an isolated loopback fixture API");
  }
  const started = performance.now();
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
  const responseHeadersMs = performance.now() - started;
  const body = await response.arrayBuffer();
  const bodyCompleteMs = performance.now() - started;
  if (!response.ok) throw new Error(`fixture HTTP ${url.pathname}: ${response.status}`);
  return { status: response.status, bytes: body.byteLength, responseHeadersMs, bodyCompleteMs };
}
