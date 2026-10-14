import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createCloudAccountClient } from "../../../electron/cloud-account.mjs";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import worker from "../src/index";

async function serve(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function desktopFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const { cache: _cache, credentials: _credentials, redirect: _redirect, ...kept } = init;
  return serve(new Request(input, kept));
}

async function signIn(email: string): Promise<string> {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await serve(new Request(`${readConfig(env).authBaseURL}/api/auth/sign-in/email-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, otp, name: email.split("@", 1)[0] }),
  }));
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("no bearer");
  return token;
}

async function until<T>(check: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the desktop app's own Cloud client against this service", () => {
  it("signs in with a device code, sees a ready home, pairs with it and signs out", async () => {
    const origin = readConfig(env).authBaseURL;
    const opened: string[] = [];
    const timers: Array<() => void> = [];
    let saved: unknown = null;
    const client = createCloudAccountClient({
      store: { read: async () => saved, write: async (value: unknown) => { saved = value; } },
      openBrowser: async (url: string) => { opened.push(url); },
      platform: "darwin",
      deviceName: "Ada's MacBook Air",
      appVersion: "0.3.26",
      origin,
      fetch: desktopFetch as typeof fetch,
      setTimer: ((work: () => void) => { timers.push(work); return timers.length; }) as unknown as typeof setTimeout,
      clearTimer: (() => undefined) as unknown as typeof clearTimeout,
      warn: () => undefined,
    });
    await client.start();
    const begun = await client.begin();
    expect(begun.status).toBe("connecting");
    const userCode = begun.enrollment?.userCode ?? "";
    expect(opened).toEqual([`${origin}/cloud/desktop?code=${userCode}`]);

    const token = await signIn("ada@example.com");
    const approved = await serve(new Request(`${origin}/api/cloud/desktop/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ userCode, decision: "allow" }),
    }));
    expect(approved.status).toBe(200);

    timers.shift()?.();
    const connected = await until(() => {
      const state = client.state();
      return state.status === "connected" && state.machine ? state : undefined;
    }, "the desktop to see its Cloud");
    expect(connected).toMatchObject({
      account: { email: "ada@example.com" },
      entitlement: { plan: "pro", tier: "beta", status: "active" },
      machine: { status: "ready" },
    });
    expect(client.homeTarget()?.origin).toMatch(/^https:\/\/h[0-9a-f]{24}-home\.later\.dog$/);

    const grant = await client.pairHome();
    expect(grant).toMatchObject({ origin: client.homeTarget()?.origin, code: "ABCD-EFGH-JKLM" });

    const signedOut = await client.signOut();
    expect(signedOut.status).toBe("signed-out");
    expect(saved).toBeNull();
    client.close();
  });
});
