import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY } from "../src/trial";
import { ORIGIN, T0, apiRequest, body, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function square(start: { chargedThrough: number }) {
  const state = { status: "ACTIVE", chargedThrough: start.chargedThrough, links: 0, canceled: 0, customer: "CUST1" as string | null };
  const calls: Array<{ method: string; path: string; body: any; headers: Headers }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) };
    calls.push(call);
    const sub = () => ({ id: "SUB1", status: state.status, plan_variation_id: "H7QYVJZLBX4NCKAP6LT7HQDA", customer_id: "CUST1", charged_through_date: day(state.chargedThrough) });
    if (call.path === "/v2/online-checkout/payment-links") { state.links++; return Response.json({ payment_link: { id: "LINK1", url: "https://square.link/u/abc", order_id: "ORDER1" } }); }
    if (call.path === "/v2/orders/ORDER1") return Response.json({ order: { id: "ORDER1", state: "OPEN", ...(state.customer ? { customer_id: state.customer } : {}) } });
    if (call.path === "/v2/subscriptions/search") return Response.json({ subscriptions: [sub()] });
    if (call.path === "/v2/subscriptions/SUB1") return Response.json({ subscription: sub() });
    if (call.path === "/v2/subscriptions/SUB1/cancel") { state.canceled++; state.status = "CANCELED"; return Response.json({ subscription: sub() }); }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  return { state, calls };
}

const SQUARE_VARS = { SQUARE_LOCATION_ID: "L7GC619QNDQ55", SQUARE_PLAN_VARIATION_ID: "H7QYVJZLBX4NCKAP6LT7HQDA", PLAN_PRICE_CENTS: "1000", PLAN_HOURS: "40", PLAN_GRACE_DAYS: "3" };

async function paid(vars: Record<string, string> = { SQUARE_ACCESS_TOKEN: "sq-test" }) {
  const w = await world({ ...SQUARE_VARS, ...vars });
  const key = trialKey("p");
  const sq = square({ chargedThrough: T0 + 30 * DAY });
  return { w, key, sq };
}

const checkout = async (w: Awaited<ReturnType<typeof world>>, key: string) => w.fetch(apiRequest("POST", "/v1/plan/checkout", key));
const done = async (w: Awaited<ReturnType<typeof world>>, link: string) => w.fetch(new Request(`${ORIGIN}/plan/done?ref=${new URL(link).searchParams.get("ref")}`));

describe("later.dog Cloud through Square", () => {
  it("is closed until Square is set up, without calling Square", async () => {
    const { w, key, sq } = await paid({});
    expect((await checkout(w, key)).status).toBe(503);
    expect(await body(await w.fetch(apiRequest("GET", "/v1/plan", key)))).toEqual({ plan: { status: "none" } });
    expect((await body(await w.fetch(new Request(`${ORIGIN}/v1/trials`)))).planOffered).toBeUndefined();
    expect(sq.calls).toEqual([]);
  });

  it("opens Square checkout for the later.dog Cloud plan, then turns the key into a paid cloud computer once Square confirms it", async () => {
    const { w, key, sq } = await paid();
    const started = await checkout(w, key);
    expect(started.status).toBe(201);
    expect((await body(started)).url).toBe("https://square.link/u/abc");
    const create = sq.calls[0]!;
    expect(create.headers.get("authorization")).toBe("Bearer sq-test");
    expect(create.body).toMatchObject({
      quick_pay: { name: "later.dog Cloud", price_money: { amount: 1000, currency: "USD" }, location_id: "L7GC619QNDQ55" },
      checkout_options: { subscription_plan_id: "H7QYVJZLBX4NCKAP6LT7HQDA" },
    });
    const redirect = create.body.checkout_options.redirect_url as string;
    expect(redirect).toMatch(/^https:\/\/computers\.example\/plan\/done\?ref=[a-f0-9]{32}$/);

    const page = await done(w, redirect);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("You&#39;re on later.dog Cloud");
    const status = await body(await w.fetch(apiRequest("GET", "/v1/trial", key)));
    expect(status.trial).toMatchObject({ state: "active", minutes: 2400, minutesLeft: 2400 });
    expect(status.planOffered).toBe(true);
    expect((await body(await w.fetch(new Request(`${ORIGIN}/v1/trials`)))).planOffered).toBe(true);
    expect(status.plan).toEqual({ status: "active", periodEnd: new Date(Date.parse(`${day(T0 + 30 * DAY)}T00:00:00Z`)).toISOString() });
    expect((await w.fetch(apiRequest("DELETE", "/v1/trial", key))).status).toBe(409);
    expect((await checkout(w, key)).status).toBe(200);
    expect(sq.state.links).toBe(1);
  });

  it("waits on the checkout page until Square knows who paid", async () => {
    const { w, key, sq } = await paid();
    sq.state.customer = null;
    const redirect = (await checkout(w, key), sq.calls[0]!.body.checkout_options.redirect_url as string);
    const page = await done(w, redirect);
    expect(page.status).toBe(202);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", key))).status).toBe(401);
    expect((await w.fetch(new Request(`${ORIGIN}/plan/done?ref=${"0".repeat(32)}`))).status).toBe(404);
  });

  it("keeps a paid computer through renewals, and ends it only after a cancelled plan runs out", async () => {
    const { w, key, sq } = await paid();
    await done(w, (await checkout(w, key), sq.calls[0]!.body.checkout_options.redirect_url as string));
    sq.state.chargedThrough = T0 + 61 * DAY;
    await w.advance(34 * DAY);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).plan.status).toBe("active");

    const cancel = await w.fetch(apiRequest("DELETE", "/v1/plan", key));
    expect((await body(cancel)).plan.status).toBe("canceled");
    expect(sq.state.canceled).toBe(1);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", key))).status).toBe(200);
    await w.advance(40 * DAY);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", key))).status).toBe(401);
  });
});
