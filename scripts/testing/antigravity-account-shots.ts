import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { InstanceInfo } from "../../src/state/store.tsx";
import { mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const output = process.env.LATERDOG_SHOTS_DIR || join(REPO_ROOT, ".laterdog-evidence/antigravity-account");
mkdirSync(output, { recursive: true });
const GOOGLE = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=preview&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid%20email&state=preview";
const INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
const MODELS = [["gemini-4-neon", "Gemini 4 Neon"], ["gemini-4-carbon", "Gemini 4 Carbon"], ["gemini-4-argon", "Gemini 4 Argon"], ["gemini-4-hydrogen", "Gemini 4 Hydrogen"], ["gemini-4-orchestrator", "Gemini 4 Orchestrator"], ["gemini-3.8-flash", "Gemini 3.8 Flash"]]
  .map(([id, label]) => ({ id: id!, label: label! }));

const account = (instanceId: string, driverKind: string, displayName: string, signedIn: boolean, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName, access: "subscription",
  snapshot: { state: "available", authenticated: signedIn, version: "1.0.0", ...(signedIn ? { account: { email: "ada@example.test" } } : {}) },
  models: { default: "", options: [] },
  ...extra,
});

function instances(antigravitySignedIn: boolean): InstanceInfo[] {
  return [
    account("claude", "claudeAgent", "Claude", true, {
      models: { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5", label: "Opus 5.5" }] },
      authentication: { method: "paste-code", signOut: true },
      claudeAccount: { configDir: "", signInCommand: "echo preview", signInShell: "sh", isDefault: true },
    }),
    account("chatgpt", "codex", "ChatGPT", false, { authentication: { method: "browser-pkce", signOut: true } }),
    account("cursor", "cursorAgent", "Cursor", false, { authentication: { method: "device-code", signOut: true } }),
    account("antigravity", "antigravityAgent", "Antigravity", antigravitySignedIn, {
      models: antigravitySignedIn ? { default: "gemini-4-hydrogen", options: MODELS } : { default: "", options: [] },
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      authentication: { method: "paste-code", signOut: true },
      install: { command: { darwin: INSTALL, linux: INSTALL } },
    }),
  ];
}

const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};
const signedInFor = (req: IncomingMessage) => new URL(req.headers.referer ?? "http://preview/").searchParams.get("state") === "signed-in";
const waiting = () => ({ phase: "waiting", flowId: "preview-flow", authorizationUrl: GOOGLE, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });

const ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, {
  entry: "/scripts/testing/antigravity-account-preview.tsx", route: "/__antigravity-account.html", title: "Antigravity account preview", logLevel: "warn",
  extraRoutes: [
    { path: "/api/instances", method: "GET", handler: (req, res) => json(res, { instances: instances(signedInFor(req)) }) },
    { path: /^\/api\/instances\/antigravity\/auth\/(?:start|status)$/, handler: (_req, res) => json(res, { auth: waiting() }) },
    { path: /^\/api\/instances\/[^/]+\/refresh-models$/, method: "POST", handler: (req, res) => json(res, { instances: instances(signedInFor(req)) }) },
    { path: "/api/plan-usage", handler: (_req, res) => json(res, { providers: [] }) },
    { path: /^\/(?:api|\.well-known)\//, handler: (_req, res) => json(res, { error: "Preview only" }, 404) },
  ],
});

type Clipped = { text: string; scrollWidth: number; clientWidth: number };
const clippedIn = (root: string) => `(() => [...document.querySelectorAll(${JSON.stringify(root)})].flatMap((scope) => [scope, ...scope.querySelectorAll("*")])
  .filter((node) => node instanceof HTMLElement && node.offsetParent !== null && node.textContent.trim() && !node.closest("[data-chat-ai]")
    && (getComputedStyle(node).textOverflow === "ellipsis" || ["hidden", "clip"].includes(getComputedStyle(node).overflowX))
    && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1))
  .map((node) => ({ text: node.textContent.trim().slice(0, 80), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })))()`;

const { chromium } = await import(process.env.LATERDOG_PANEL_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.LATERDOG_PANEL_CHROME || undefined });
const found: Array<{ shot: string; clipped: Clipped[] }> = [];
try {
  for (const skin of ["daylight", "midnight"] as const) {
    for (const [width, zoom] of [[720, 1], [360, 1], [720, 2]] as const) {
      const context = await browser.newContext({ viewport: { width, height: 720 }, deviceScaleFactor: 2, timezoneId: "America/Los_Angeles" });
      const page = await context.newPage();
      const size = zoom === 1 ? `${width}` : `${width}-zoom${zoom}`;
      const open = async (query: string) => {
        await page.goto(`${ui.previewUrl}?skin=${skin}&${query}`);
        if (zoom !== 1) await page.evaluate((value: number) => { document.documentElement.style.zoom = String(value); }, zoom);
      };
      const shot = async (name: string, root: string) => {
        await page.waitForTimeout(400);
        const clipped = await page.evaluate(clippedIn(root)) as Clipped[];
        found.push({ shot: `${name}-${size}-${skin}`, clipped });
        await page.screenshot({ path: join(output, `${name}-${size}-${skin}.png`) });
      };
      await open("state=signed-out");
      await page.getByRole("button", { name: "Add account" }).click();
      const tile = page.locator('[role="dialog"] [data-account-engine="antigravityAgent"]');
      await tile.waitFor();
      assert.equal(await tile.isDisabled(), false);
      await shot("signed-out-add-account", '[role="dialog"]');
      await tile.click();
      await page.locator('[role="dialog"] [data-sign-in-link]').waitFor();
      assert.equal(await page.locator('[role="dialog"] [data-sign-in-link]').getAttribute("href"), GOOGLE);
      await shot("paste-step", '[role="dialog"]');
      await open("state=signed-in");
      await page.locator("[data-account-note]").waitFor();
      assert.equal(await page.locator("[data-account-note]").textContent(), "Google limits automated use of personal plans.");
      assert.equal(await page.locator("[data-preview-accounts] [data-account-usage]").count(), 0);
      await shot("signed-in", "[data-preview-accounts]");
      await open("state=signed-in&view=picker");
      await page.locator("[data-chat-ai]").click();
      await page.locator("[data-model-picker-content]").waitFor();
      await shot("model-picker", "[data-model-picker-content]");
      await open("state=signed-in&view=simple");
      await page.locator('[data-tour="model"]').click();
      await page.locator("[data-simple-effort-band] button").first().waitFor();
      assert.deepEqual(await page.locator("[data-simple-effort-band] button[aria-pressed]").allTextContents(), ["Low", "Medium", "High", "Extra high", "Max"]);
      await shot("model-picker-simple", "[data-model-picker-content]");
      await context.close();
    }
  }
} finally {
  await browser.close();
  await ui.close();
}
console.log(JSON.stringify({ output, clipped: found.filter((entry) => entry.clipped.length > 0) }, null, 2));
assert.deepEqual(found.flatMap((entry) => entry.clipped), [], "text is cut off somewhere");
