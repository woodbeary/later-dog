import { describe, expect, it } from "vitest";
import {
  exchangeGoogleCode,
  findCode,
  GMAIL_READONLY_SCOPE,
  GoogleAccessTokens,
  googleAccountItem,
  googleAuthUrl,
  gmailClient,
  htmlToText,
  isGoogleAccountItem,
  messageText,
  parseGoogleAccount,
  parseGoogleClient,
  PendingGoogleAuths,
  type FetchLike,
} from "./google.ts";

const CLIENT = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh" };
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function fakeGoogle(routes: Record<string, (init?: RequestInit) => unknown>, calls: string[] = []): FetchLike {
  return async (url, init) => {
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const out = routes[key]!(init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  };
}

describe("Google OAuth", () => {
  it("asks Google's own consent page for read-only Gmail, offline, with PKCE and the account hint", () => {
    const url = new URL(googleAuthUrl({ client: CLIENT, redirectUri: "https://home.example/google-oauth/callback", state: "s1", challenge: "c1", loginHint: "lopez731@gmail.com" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_READONLY_SCOPE}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("login_hint")).toBe("lopez731@gmail.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://home.example/google-oauth/callback");
  });

  it("hands out each state once and forgets it after 15 minutes", () => {
    let now = 0;
    const pending = new PendingGoogleAuths(() => now);
    const { pending: a } = pending.start({ botId: "b", threadId: "t" });
    expect(pending.take(a.state)?.botId).toBe("b");
    expect(pending.take(a.state)).toBeNull();
    const { pending: b } = pending.start({ botId: "b", threadId: "t" });
    now = 16 * 60_000;
    expect(pending.take(b.state)).toBeNull();
  });

  it("exchanges the code, insists on gmail.readonly and a refresh token, and learns the email", async () => {
    const bodies: string[] = [];
    const fetcher = fakeGoogle({
      "https://oauth2.googleapis.com/token": (init) => { bodies.push(String(init?.body)); return { access_token: "at", refresh_token: "rt", scope: `openid ${GMAIL_READONLY_SCOPE}` }; },
      "https://openidconnect.googleapis.com/v1/userinfo": () => ({ email: "Lopez731@gmail.com" }),
    });
    const account = await exchangeGoogleCode(fetcher, { client: CLIENT, code: "c", verifier: "v", redirectUri: "https://h/cb" }, 5);
    expect(account).toEqual({ email: "lopez731@gmail.com", refreshToken: "rt", scope: `openid ${GMAIL_READONLY_SCOPE}`, connectedAt: 5 });
    expect(new URLSearchParams(bodies[0]).get("code_verifier")).toBe("v");
    const narrow = fakeGoogle({ "https://oauth2.googleapis.com/token": () => ({ access_token: "at", refresh_token: "rt", scope: "openid email" }) });
    await expect(exchangeGoogleCode(narrow, { client: CLIENT, code: "c", verifier: "v", redirectUri: "x" }, 0)).rejects.toThrow(/read access to Gmail/);
  });

  it("caches the access token until shortly before it lapses", async () => {
    let now = 0;
    let minted = 0;
    const tokens = new GoogleAccessTokens(fakeGoogle({ "https://oauth2.googleapis.com/token": () => ({ access_token: `t${++minted}`, expires_in: 3600 }) }), () => now);
    const account = { email: "a@b.co", refreshToken: "rt", scope: "", connectedAt: 0 };
    expect(await tokens.token(CLIENT, account)).toBe("t1");
    expect(await tokens.token(CLIENT, account)).toBe("t1");
    now = 3500_000;
    expect(await tokens.token(CLIENT, account)).toBe("t2");
  });

  it("stores each account under its own vault item and reads it back", () => {
    expect(googleAccountItem("Lopez731@gmail.com")).toBe(googleAccountItem("lopez731@gmail.com"));
    expect(googleAccountItem("a+b@gmail.com")).not.toBe(googleAccountItem("a_b@gmail.com"));
    expect(isGoogleAccountItem("google/x_at_y.com/REFRESH_TOKEN")).toBe(true);
    expect(isGoogleAccountItem("google/codes/latest")).toBe(false);
    expect(parseGoogleAccount(JSON.stringify({ email: "a@b.co", refreshToken: "r", scope: "s", connectedAt: 1 }))?.email).toBe("a@b.co");
    expect(parseGoogleAccount("{}")).toBeNull();
    expect(parseGoogleClient(" 1-x.apps.googleusercontent.com ", "sec")).toEqual({ clientId: "1-x.apps.googleusercontent.com", clientSecret: "sec" });
    expect(parseGoogleClient("not-a-client", "sec")).toBeNull();
  });
});

describe("Gmail", () => {
  it("searches, then reads metadata and the text body, falling back from HTML", async () => {
    const calls: string[] = [];
    const message = {
      id: "m1", threadId: "t1", snippet: "Your code", internalDate: "1700000000000", labelIds: ["INBOX"],
      payload: { headers: [{ name: "From", value: "Nextdoor <no-reply@nextdoor.com>" }, { name: "Subject", value: "Your code" }],
        parts: [{ mimeType: "text/html", body: { data: b64("<p>Your code is <b>482913</b></p>") } }, { filename: "logo.png", mimeType: "image/png" }] },
    };
    const gmail = gmailClient(fakeGoogle({
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?": () => ({ messages: [{ id: "m1" }] }),
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": () => message,
    }, calls), async () => "at");
    const hits = await gmail.search("from:nextdoor.com", 5);
    expect(hits).toEqual([expect.objectContaining({ id: "m1", from: "Nextdoor <no-reply@nextdoor.com>", subject: "Your code" })]);
    expect(new URL(calls[0]!).searchParams.get("q")).toBe("from:nextdoor.com");
    const full = await gmail.read("m1");
    expect(full.text).toContain("Your code is 482913");
    expect(full.attachments).toEqual(["logo.png"]);
  });

  it("prefers the plain part and finds a code of the asked length only", () => {
    expect(messageText({ parts: [{ mimeType: "text/plain", body: { data: b64("plain 123456") } }, { mimeType: "text/html", body: { data: b64("<b>html</b>") } }] }).text).toBe("plain 123456");
    expect(htmlToText("<style>x{}</style><div>a&amp;b</div>c")).toBe("a&b\nc");
    expect(findCode("Order 1234567, code 482913, call 555-123456", 6)).toBe("482913");
    expect(findCode("no code here", 6)).toBeNull();
  });
});
