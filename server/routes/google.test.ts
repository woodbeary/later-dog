import { describe, expect, it } from "vitest";
import { GMAIL_READONLY_SCOPE, GoogleAccessTokens, PendingGoogleAuths, type FetchLike, type GoogleAccountRecord, type PendingGoogleAuth } from "../laterdog/google.ts";
import { answerGoogleCallback, createGoogleRoute, GOOGLE_OWNER_ONLY, maskDigits, pickAccount, type GoogleRouteDeps } from "./google.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const NOW = Date.UTC(2026, 10, 10, 18);

function setup(opts: { owner?: boolean; client?: boolean; accounts?: GoogleAccountRecord[] } = {}) {
  const accounts = [...(opts.accounts ?? [])];
  const secrets = new Map<string, string>();
  const cards: Array<{ url: string; service: string }> = [];
  const finished: Array<[string, string]> = [];
  const calls: string[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push(url);
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body));
      return body.get("grant_type") === "authorization_code"
        ? reply({ access_token: "at", refresh_token: "rt-new", scope: `openid email ${GMAIL_READONLY_SCOPE}` })
        : reply({ access_token: "at", expires_in: 3600 });
    }
    if (url.startsWith("https://openidconnect.googleapis.com")) return reply({ email: "lopez731@gmail.com" });
    if (url.includes("/messages?")) return reply({ messages: [{ id: "msg001" }] });
    if (url.includes("/messages/msg001")) {
      return reply({ id: "msg001", internalDate: String(NOW - 60_000), payload: {
        headers: [{ name: "From", value: "no-reply@nextdoor.com" }, { name: "Subject", value: "Your Nextdoor code is 482913" }],
        mimeType: "text/plain", body: { data: b64("Use 482913 to sign in.") } } });
    }
    return new Response("{}", { status: 404 });
  };
  const deps: GoogleRouteDeps = {
    ownerActing: () => opts.owner ?? true,
    client: () => (opts.client === false ? null : { clientId: "1-x.apps.googleusercontent.com", clientSecret: "s" }),
    redirectUri: () => "https://home.example/google-oauth/callback",
    accounts: () => accounts,
    saveAccount: (account) => { accounts.push(account); },
    saveSecret: (name, value) => { const replaced = secrets.has(name); secrets.set(name, value); return { replaced }; },
    pending: new PendingGoogleAuths(() => NOW),
    tokens: new GoogleAccessTokens(fetcher, () => NOW),
    fetcher,
    postCard: (_s, _t, input) => { cards.push(input); return `card${cards.length}`; },
    finishCard: (pending: PendingGoogleAuth, outcome, detail) => { finished.push([`${pending.messageId}:${outcome}`, detail]); },
    now: () => NOW,
  };
  const route = createGoogleRoute(deps);
  const call = async (body: Record<string, unknown>) => {
    let status = 0;
    let out: Record<string, unknown> = {};
    await route({
      res: {} as never, path: "/api/internal/google", method: "POST", url: new URL("http://x"), req: {} as never,
      json: ((_r: unknown, code: number, value: Record<string, unknown>) => { status = code; out = value; }) as never,
      sender: { id: "nextdoor", name: "nextdoor", color: "#000" } as never, threadId: "t1", capability: {}, readBody: async () => body,
    });
    return { status, out };
  };
  return { deps, call, cards, finished, secrets, accounts, calls };
}

const LOPEZ = { email: "lopez731@gmail.com", refreshToken: "rt", scope: GMAIL_READONLY_SCOPE, connectedAt: 1 };

describe("Google route", () => {
  it("connects through a card and Google's callback, saving the account, and refuses a replayed state", async () => {
    const h = setup();
    const made = await h.call({ action: "connect", account: "lopez731@gmail.com" });
    expect(made.status).toBe(201);
    expect(String(made.out.text)).toContain("Never open the consent page in your own browser");
    const url = new URL(h.cards[0]!.url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(h.cards[0]!.service).toBe("Google (lopez731@gmail.com)");
    const state = url.searchParams.get("state")!;
    const page = await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }));
    expect(page.status).toBe(200);
    expect(page.html).toContain("Connected lopez731@gmail.com");
    expect(page.html).not.toContain("rt-new");
    expect(h.accounts.map((a) => [a.email, a.refreshToken])).toEqual([["lopez731@gmail.com", "rt-new"]]);
    expect(h.finished).toEqual([["card1:connected", "Connected lopez731@gmail.com with read-only Gmail."]]);
    expect((await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "again" }))).status).toBe(400);
  });

  it("reports a declined consent to the waiting dog", async () => {
    const h = setup();
    await h.call({ action: "connect" });
    const state = new URL(h.cards[0]!.url).searchParams.get("state")!;
    await answerGoogleCallback(h.deps, new URLSearchParams({ state, error: "access_denied" }));
    expect(h.finished).toEqual([["card1:failed", "The owner declined on Google's page."]]);
    expect(h.accounts).toEqual([]);
  });

  it("is only for the owner's own dogs, and explains a missing OAuth client", async () => {
    expect(await setup({ owner: false }).call({ action: "accounts" })).toMatchObject({ status: 403, out: { error: GOOGLE_OWNER_ONLY } });
    const noClient = await setup({ client: false }).call({ action: "connect" });
    expect(noClient.status).toBe(409);
    expect(String(noClient.out.error)).toContain("https://home.example/google-oauth/callback");
  });

  it("searches and reads Gmail for the connected account", async () => {
    const h = setup({ accounts: [LOPEZ] });
    const found = await h.call({ action: "search", query: "from:nextdoor.com" });
    expect(found).toMatchObject({ status: 200, out: { account: "lopez731@gmail.com", messages: [{ id: "msg001" }] } });
    const read = await h.call({ action: "read", id: "msg001" });
    expect((read.out.message as { text: string }).text).toBe("Use 482913 to sign in.");
    expect((await h.call({ action: "read", id: "bad id" })).status).toBe(400);
  });

  it("saves an emailed code to the vault without returning it", async () => {
    const h = setup({ accounts: [LOPEZ] });
    const saved = await h.call({ action: "code", from: "nextdoor.com", name: "nextdoor/jacob-reply/CODE" });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.out)).not.toContain("482913");
    expect(String(saved.out.text)).toContain("Your Nextdoor code is ••••••");
    expect(h.secrets.get("nextdoor/jacob-reply/CODE")).toBe("482913");
    const query = new URL(h.calls.find((c) => c.includes("/messages?"))!).searchParams.get("q");
    expect(query).toBe(`from:nextdoor.com after:${Math.floor((NOW - 15 * 60_000) / 1000)}`);
    expect((await h.call({ action: "code", from: "nextdoor.com", name: "bad name!" })).status).toBe(400);
  });

  it("picks the account by email when several are connected", () => {
    const two = [LOPEZ, { ...LOPEZ, email: "jacob@txtclaw.com" }];
    expect(pickAccount(two, undefined)).toMatch(/name one/);
    expect(pickAccount(two, "JACOB@txtclaw.com")).toMatchObject({ email: "jacob@txtclaw.com" });
    expect(pickAccount([], undefined)).toMatch(/connect_google/);
    expect(maskDigits("code 482913 and 12", 6)).toBe("code •••••• and 12");
  });
});

it("refuses a different Google account from the one requested", async () => {
  const h = setup();
  await h.call({ action: "connect", account: "other@gmail.com" });
  const state = new URL(h.cards[0]!.url).searchParams.get("state")!;
  const answer = await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }));
  expect(answer.status).toBe(400);
  expect(h.accounts).toEqual([]);
  expect(h.finished[0]![0]).toBe("card1:failed");
});

it("does not return provider error bodies to the callback or dog", async () => {
  const h = setup();
  h.deps.fetcher = async () => new Response(JSON.stringify({ error_description: "secret-provider-value" }), { status: 400 });
  await h.call({ action: "connect" });
  const state = new URL(h.cards[0]!.url).searchParams.get("state")!;
  const answer = await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }));
  expect(answer.html).not.toContain("secret-provider-value");
  expect(JSON.stringify(h.finished)).not.toContain("secret-provider-value");
});
