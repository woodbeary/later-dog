export interface SquareEnv {
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_ENVIRONMENT?: string;
  SQUARE_API_VERSION?: string;
  SQUARE_LOCATION_ID?: string;
  SQUARE_PLAN_VARIATION_ID?: string;
  PLAN_PRICE_CENTS?: string;
}

export interface PaymentLink { id: string; url: string; orderId: string }
export interface SquareSubscription { id: string; status: string; chargedThroughDate?: string; canceledDate?: string; planVariationId?: string; customerId?: string }

export const squareConfigured = (env: SquareEnv) => Boolean(env.SQUARE_ACCESS_TOKEN?.trim() && env.SQUARE_LOCATION_ID?.trim() && env.SQUARE_PLAN_VARIATION_ID?.trim());

const base = (env: SquareEnv) => (env.SQUARE_ENVIRONMENT === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function square(env: SquareEnv, method: string, path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`${base(env)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN?.trim() ?? ""}`,
      "square-version": env.SQUARE_API_VERSION?.trim() || "2026-05-20",
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || !isRecord(json)) {
    const detail = isRecord(json) && Array.isArray(json.errors) ? JSON.stringify(json.errors).slice(0, 300) : String(response.status);
    throw new Error(`Square ${method} ${path.split("?")[0]} failed: ${detail}`);
  }
  return json;
}

export async function createPlanLink(env: SquareEnv, input: { idempotencyKey: string; redirectUrl: string }, fetcher?: typeof fetch): Promise<PaymentLink> {
  const json = await square(env, "POST", "/v2/online-checkout/payment-links", {
    idempotency_key: input.idempotencyKey,
    quick_pay: {
      name: "later.dog Cloud",
      price_money: { amount: Number(env.PLAN_PRICE_CENTS ?? "1000"), currency: "USD" },
      location_id: env.SQUARE_LOCATION_ID?.trim(),
    },
    checkout_options: { subscription_plan_id: env.SQUARE_PLAN_VARIATION_ID?.trim(), redirect_url: input.redirectUrl },
  }, fetcher);
  const link = json.payment_link;
  if (!isRecord(link) || typeof link.id !== "string" || typeof link.url !== "string" || typeof link.order_id !== "string") {
    throw new Error("Square did not return a payment link");
  }
  return { id: link.id, url: link.url, orderId: link.order_id };
}

export async function orderCustomer(env: SquareEnv, orderId: string, fetcher?: typeof fetch): Promise<{ state: string; customerId: string | null }> {
  const json = await square(env, "GET", `/v2/orders/${encodeURIComponent(orderId)}`, undefined, fetcher);
  const order = isRecord(json.order) ? json.order : {};
  return { state: typeof order.state === "string" ? order.state : "", customerId: typeof order.customer_id === "string" ? order.customer_id : null };
}

const subscriptionOf = (raw: unknown): SquareSubscription | null => {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") return null;
  return {
    id: raw.id,
    status: raw.status,
    ...(typeof raw.charged_through_date === "string" ? { chargedThroughDate: raw.charged_through_date } : {}),
    ...(typeof raw.canceled_date === "string" ? { canceledDate: raw.canceled_date } : {}),
    ...(typeof raw.plan_variation_id === "string" ? { planVariationId: raw.plan_variation_id } : {}),
    ...(typeof raw.customer_id === "string" ? { customerId: raw.customer_id } : {}),
  };
};

export async function customerPlan(env: SquareEnv, customerId: string, fetcher?: typeof fetch): Promise<SquareSubscription | null> {
  const json = await square(env, "POST", "/v2/subscriptions/search", {
    query: { filter: { customer_ids: [customerId], location_ids: [env.SQUARE_LOCATION_ID?.trim()] } },
  }, fetcher);
  const all = Array.isArray(json.subscriptions) ? json.subscriptions.map(subscriptionOf).filter((sub): sub is SquareSubscription => sub !== null) : [];
  const ours = all.filter((sub) => sub.planVariationId === env.SQUARE_PLAN_VARIATION_ID?.trim());
  return ours.find((sub) => sub.status === "ACTIVE") ?? ours.find((sub) => sub.status === "PENDING") ?? ours[0] ?? null;
}

export async function subscription(env: SquareEnv, id: string, fetcher?: typeof fetch): Promise<SquareSubscription | null> {
  const json = await square(env, "GET", `/v2/subscriptions/${encodeURIComponent(id)}`, undefined, fetcher);
  return subscriptionOf(json.subscription);
}

export async function cancelSubscription(env: SquareEnv, id: string, fetcher?: typeof fetch): Promise<SquareSubscription | null> {
  const json = await square(env, "POST", `/v2/subscriptions/${encodeURIComponent(id)}/cancel`, {}, fetcher);
  return subscriptionOf(json.subscription);
}

export function paidThrough(sub: SquareSubscription, now: number): number | null {
  if (sub.status !== "ACTIVE" && sub.status !== "PENDING") {
    if (sub.status !== "CANCELED" || !sub.chargedThroughDate) return null;
  }
  const until = sub.chargedThroughDate ? Date.parse(`${sub.chargedThroughDate}T00:00:00Z`) : NaN;
  if (Number.isFinite(until) && until > now) return until;
  return sub.status === "ACTIVE" || sub.status === "PENDING" ? now + 31 * 24 * 60 * 60 * 1000 : null;
}
