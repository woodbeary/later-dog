interface TestHomes {
  open(accountId: string): Promise<unknown>;
  summary(accountId: string): Promise<unknown>;
  pair(accountId: string, input: { label: string; ttlSeconds: number }): Promise<unknown>;
  remove(accountId: string): Promise<unknown>;
}

interface Env {
  HOMES: TestHomes;
  DRIVER_TOKEN: string;
}

const TEST_ACCOUNT = /^test-[a-z0-9-]{1,60}$/;
const PAIRING_LABEL = "later.dog test home";
const PAIRING_TTL_SECONDS = 300;

async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.DRIVER_TOKEN || env.DRIVER_TOKEN.length < 32) return false;
  return sameSecret(request.headers.get("authorization") ?? "", `Bearer ${env.DRIVER_TOKEN}`);
}

async function testAccount(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as { accountId?: unknown } | null;
  const accountId = typeof body?.accountId === "string" ? body.accountId : "";
  return TEST_ACCOUNT.test(accountId) ? accountId : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!(await authorized(request, env))) return new Response("Unauthorized", { status: 401 });
    const accountId = await testAccount(request);
    if (!accountId) return Response.json({ error: "Only test-* accounts can be driven here." }, { status: 400 });
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/open") return Response.json(await env.HOMES.open(accountId));
      if (pathname === "/summary") return Response.json(await env.HOMES.summary(accountId));
      if (pathname === "/pair") return Response.json(await env.HOMES.pair(accountId, { label: PAIRING_LABEL, ttlSeconds: PAIRING_TTL_SECONDS }));
      if (pathname === "/remove") return Response.json(await env.HOMES.remove(accountId));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
