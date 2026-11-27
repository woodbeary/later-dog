export const CONNECT_RETRY_MS = 5_000;
export const CONNECT_RETRY_EVERY_MS = 250;
const CONNECT_FAILURES = [/^Error proxying request to container/, /^Container suddenly disconnected/];

export function replayable(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export async function connectFailed(response: Response): Promise<boolean> {
  if (response.status !== 500) return false;
  const text = await response.clone().text().catch(() => "");
  return CONNECT_FAILURES.some((failure) => failure.test(text));
}

export async function fetchThroughRestart(
  send: (request: Request) => Promise<Response>,
  request: Request,
  { waitMs = CONNECT_RETRY_MS, everyMs = CONNECT_RETRY_EVERY_MS, now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {},
): Promise<Response> {
  const response = await send(replayable(request) ? new Request(request) : request);
  if (!replayable(request) || !(await connectFailed(response))) return response;
  const until = now() + waitMs;
  let last = response;
  while (now() < until && !request.signal?.aborted) {
    await sleep(everyMs);
    last.body?.cancel().catch(() => undefined);
    last = await send(new Request(request));
    if (!(await connectFailed(last))) return last;
  }
  return last;
}
