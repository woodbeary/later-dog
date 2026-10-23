import type { StateBucket } from "./state.ts";

export const DEV_CODE_PREFIX = "dev-code/";
const DEV_CODE_PATH = /^\/dev-code(?:\.json|\/([a-f0-9]{64})\.tgz)$/;

export function devCodeOn(flag: string | undefined): boolean {
  return flag === "1";
}

export function devCodeKey(url: string): string | null {
  const match = DEV_CODE_PATH.exec(new URL(url).pathname);
  if (!match) return null;
  return match[1] ? `${DEV_CODE_PREFIX}${match[1]}.tgz` : `${DEV_CODE_PREFIX}current.json`;
}

export async function handleDevCode(request: Request, bucket: StateBucket): Promise<Response | null> {
  const key = devCodeKey(request.url);
  if (!key) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const object = await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers: { "content-type": "application/octet-stream", etag: object.httpEtag } });
}
