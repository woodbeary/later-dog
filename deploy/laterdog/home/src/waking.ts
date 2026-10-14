export type HomeWake = "waking" | "busy";

export const WAKE_HEADER = "x-laterdog-home";
export const LENDING_HEADER = "x-laterdog-lending";

export function isBackground(request: Request): boolean {
  return request.headers.get(LENDING_HEADER) === "1";
}
export const WAKING_RETRY_SECONDS = 2;
export const BUSY_RETRY_SECONDS = 10;

const PAGE_WORDS: Record<HomeWake, { title: string; line: string }> = {
  waking: { title: "Waking up My Cloud…", line: "Your dogs were resting. This takes a few seconds." },
  busy: { title: "later.dog is busy right now", line: "Trying again in a few seconds." },
};

function wantsPage(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

function page(wake: HomeWake, retry: number): string {
  const words = PAGE_WORDS[wake];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${retry}"><title>${words.title}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fcfcfc;color:#141414}@media (prefers-color-scheme:dark){body{background:#141414;color:#f2f2f2}}main{text-align:center;padding:24px}h1{font-size:17px;font-weight:500;margin:0 0 4px}p{margin:0;opacity:.6}</style></head><body><main><h1>${words.title}</h1><p>${words.line}</p></main></body></html>`;
}

export function wakeResponse(request: Request, wake: HomeWake): Response {
  const retry = wake === "waking" ? WAKING_RETRY_SECONDS : BUSY_RETRY_SECONDS;
  const headers = { "retry-after": String(retry), [WAKE_HEADER]: wake, "cache-control": "no-store" };
  if (wantsPage(request)) return new Response(page(wake, retry), { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  return Response.json({ error: wake, retryAfter: retry }, { status: 503, headers });
}

export function startFailure(error: unknown): HomeWake {
  const message = error instanceof Error ? error.message : String(error);
  return /no container instance that can be provided|too many containers per second/i.test(message) ? "busy" : "waking";
}
