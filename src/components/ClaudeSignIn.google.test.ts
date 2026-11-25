// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(), opened: [] as string[], signedIn: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(), api: fixture.api,
  useStore: () => ({ refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels }),
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: async (url: string) => { fixture.opened.push(url); } }));
const { ClaudeSignIn } = await import("./ClaudeSignIn");

const LINK = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fixture&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=fixture";
const PAGE = "https://antigravity.google/oauth-callback?code=4%2F0Ab_fixture-code&scope=email%20openid&state=fixture";
const waiting = (authorizationUrl = LINK) => ({ phase: "waiting", flowId: "flow-g", authorizationUrl, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const byText = (text: string) => buttons().find((element) => element.textContent?.trim() === text);
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
async function show(compact: boolean, link = LINK) {
  fixture.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/auth/start")) return { auth: waiting(link) };
    if (path.endsWith("/auth/complete")) return { ok: true, auth: { ...waiting(link), phase: "succeeded" } };
    throw new Error(`unexpected ${path}`);
  });
  await act(async () => root.render(createElement(ClaudeSignIn, { instanceId: "antigravity", provider: "google", autoStart: compact, compact, onSignedIn: fixture.signedIn })));
  await settle();
  if (!compact) {
    expect(byText("Sign in with Google")).toBeDefined();
    await act(async () => byText("Sign in with Google")!.click());
    await settle();
  }
}

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  fixture.opened = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe.each([[true], [false]])("Antigravity's Google sign-in by pasted code (compact %s)", (compact) => {
  it("shows Open Google sign-in on Google's own link, and sends the pasted page address unchanged", async () => {
    await show(compact);
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/antigravity/auth/start", { method: "POST" });
    const open = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) => anchor.textContent?.trim() === "Open Google sign-in");
    expect(open?.href).toBe(LINK);
    expect(fixture.opened).toEqual([]);
    const label = [...host.querySelectorAll("label")].find((element) => element.textContent === "Paste the code or page address here");
    expect(label).toBeDefined();
    const input = host.querySelector<HTMLInputElement>(`#${label!.getAttribute("for")}`)!;
    await type(input, PAGE);
    await act(async () => byText("Finish sign-in")!.click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/antigravity/auth/complete", { method: "POST", body: JSON.stringify({ flowId: "flow-g", code: PAGE }) });
    expect(fixture.signedIn).toHaveBeenCalledOnce();
    expect(fixture.refreshModels).toHaveBeenCalledWith("antigravity");
    expect(host.textContent).not.toMatch(/Claude|Anthropic/);
  });

  it.each([
    ["another host", "https://accounts.google.com.evil.example/o/oauth2/auth?state=x"],
    ["user info", "https://someone@accounts.google.com/o/oauth2/auth?state=x"],
    ["a port", "https://accounts.google.com:8443/o/oauth2/auth?state=x"],
    ["plain http", "http://accounts.google.com/o/oauth2/auth?state=x"],
  ])("refuses a sign-in link with %s", async (_why, link) => {
    await show(compact, link);
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Antigravity did not return a valid Google sign-in link. Cancel and try again.");
    expect(fixture.opened).toEqual([]);
  });
});
