import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { cloudPage } from "../src/cloud-pages";
import { DATA_RECIPIENTS } from "../src/legal-pages";
import worker from "../src/index";

const BASE_URL = "https://auth.laterdog.test";

async function served(path: string): Promise<string> {
  const response = cloudPage(new Request(`${BASE_URL}${path}`));
  expect(response?.status).toBe(200);
  expect(response!.headers.get("content-security-policy")).toContain("default-src 'none'");
  return await response!.text();
}

const IPHONE_DELETE_PATH = "to open Settings. Tap your email at the top, then Delete Account, and confirm.";
const WEB_DELETE_PATH = 'sign in at <a href="/cloud">accounts.later.dog/cloud</a> with your email, choose Delete account';

describe("support page", () => {
  it("says what later.dog is, how to get help, how to delete the account, and links privacy and terms", async () => {
    const page = await served("/support");
    expect(page).toContain("<h1>Support</h1>");
    expect(page).toContain("We call them dogs.");
    expect(page).toContain('href="mailto:support@later.dog"');
    expect(page).toContain("Send Feedback");
    expect(page).toContain(IPHONE_DELETE_PATH);
    expect(page).toContain(WEB_DELETE_PATH);
    expect(page).toContain('href="/privacy"');
    expect(page).toContain('href="/terms"');
    expect(await served("/support/")).toBe(page);
    expect(cloudPage(new Request(`${BASE_URL}/support`, { method: "POST" }))).toBeNull();
  });

  it("is served by the worker before any account routing", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE_URL}/support`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Delete your account");
  });
});

describe("privacy policy", () => {
  it("names every company that receives data", async () => {
    const page = await served("/privacy");
    expect(DATA_RECIPIENTS.map((recipient) => recipient.name)).toEqual([
      "Cloudflare", "xAI", "Anthropic", "OpenAI", "ElevenLabs", "Expo", "Apple", "Square", "GitHub", "Namecheap",
    ]);
    for (const recipient of DATA_RECIPIENTS) expect(page).toContain(`<strong>${recipient.name}</strong> ${recipient.role}`);
    expect(page).toContain("Moonshot AI and Deepgram don't receive your data");
  });

  it("says how long data is kept, how to take back consent, and the real deletion path", async () => {
    const page = await served("/privacy");
    expect(page).toContain("<h2>How long we keep it</h2>");
    expect(page).toContain("after 7 days without use");
    expect(page).toContain("up to 30 days more");
    expect(page).toContain("<h2>Changing your mind</h2>");
    expect(page).toContain("Agree and continue");
    expect(page).toContain(IPHONE_DELETE_PATH);
    expect(page).toContain(WEB_DELETE_PATH);
    expect(page).not.toContain("open Settings and choose Delete account");
  });
});

describe("public pages", () => {
  it("never mention a beta", async () => {
    for (const path of ["/privacy", "/terms", "/support", "/iphone"]) {
      expect(await served(path)).not.toMatch(/beta/i);
    }
  });

  it("let the terms point to the real deletion path", async () => {
    const terms = await served("/terms");
    expect(terms).toContain("Settings → your email → Delete Account");
    expect(terms).toContain('href="/cloud"');
  });
});
