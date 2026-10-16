import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { appSiteAssociation } from "../../../shared/apple-app";
import worker from "../src/index";

const BASE_URL = "https://auth.laterdog.test";
const ASSOCIATION = "/.well-known/apple-app-site-association";

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the app-site association on the accounts host", () => {
  it("answers Apple with JSON, no redirect and no sign-in, and claims no pages", async () => {
    const response = await call(ASSOCIATION);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    await expect(response.json()).resolves.toEqual(appSiteAssociation("service"));
  });

  it("answers a HEAD, refuses other methods, and leaves the other paths alone", async () => {
    expect((await call(ASSOCIATION, { method: "HEAD" })).status).toBe(200);
    const post = await call(ASSOCIATION, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await call("/.well-known/assetlinks.json")).status).toBe(404);
  });
});
