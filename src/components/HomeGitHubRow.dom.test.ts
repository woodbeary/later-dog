// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const links = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("@/lib/app-links", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/app-links")>(), openExternalLink: links.open }));

import { GITHUB_DEVICE_PAGE, HOME_GITHUB_POLL_MS, HomeGitHubSetting, homeGitHubView, type HomeGitHubStatus } from "./HomeGitHubRow";

const idle = { phase: "idle" as const };
const waiting = { phase: "waiting" as const, code: "AB12-CD34", url: GITHUB_DEVICE_PAGE };

let host: HTMLDivElement;
let root: Root;
let answers: Record<string, HomeGitHubStatus | Error>;
let fetches: { path: string; method: string }[];

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  setLocale("en");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetches = [];
  answers = { "GET /api/home/github": { login: null, signIn: idle } };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    fetches.push({ path, method });
    const answer = answers[`${method} ${path}`];
    if (!answer) return respond({ error: "not here" }, 404);
    if (answer instanceof Error) return respond({ error: answer.message }, 502);
    return respond(answer, path.endsWith("/connect") ? 202 : 200);
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  links.open.mockClear();
});

async function show() {
  await act(async () => { root.render(createElement(HomeGitHubSetting)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

const button = (name: string) => [...host.querySelectorAll("button")].find((element) => element.textContent === name);
const state = () => host.querySelector("[data-home-github]")?.getAttribute("data-home-github");

describe("the GitHub row in Settings on My Cloud", () => {
  it("decides what to show from the home's answer", () => {
    expect(homeGitHubView(null)).toEqual({ kind: "checking" });
    expect(homeGitHubView({ login: null, signIn: idle })).toEqual({ kind: "disconnected" });
    expect(homeGitHubView({ login: null, signIn: waiting })).toEqual({ kind: "waiting", code: "AB12-CD34" });
    expect(homeGitHubView({ login: "octocat", signIn: waiting })).toEqual({ kind: "waiting", code: "AB12-CD34" });
    expect(homeGitHubView({ login: "octocat", signIn: { phase: "done" } })).toEqual({ kind: "connected", login: "octocat" });
    expect(homeGitHubView({ login: null, signIn: { phase: "failed", detail: "the device code expired" } })).toEqual({ kind: "disconnected", problem: "the device code expired" });
    expect(homeGitHubView({ login: null, signIn: idle, detail: "Checking GitHub failed (exit 1): Bad credentials" })).toEqual({ kind: "disconnected", problem: "Checking GitHub failed (exit 1): Bad credentials" });
  });

  it("connects: shows the code, opens GitHub's device page, and turns into connected as @login", async () => {
    await show();
    expect(state()).toBe("disconnected");
    expect(host.textContent).toContain("Not connected");
    expect(host.textContent).toContain("even with your Mac closed");
    answers["POST /api/home/github/connect"] = { login: null, signIn: waiting };
    answers["GET /api/home/github"] = { login: null, signIn: waiting };
    await act(async () => { button("Connect")!.click(); });
    expect(state()).toBe("waiting");
    expect(host.querySelector("[data-home-github-code]")?.textContent).toBe("AB12-CD34");
    expect(links.open).toHaveBeenCalledWith(GITHUB_DEVICE_PAGE);
    expect(button("Open GitHub")).toBeTruthy();
    expect(host.textContent).toContain("Waiting for GitHub");
    const link = host.querySelector<HTMLButtonElement>("[data-home-github-link]")!;
    expect(link.textContent).toBe("github.com/login/device");
    expect(link.parentElement?.textContent).toBe("Enter it at github.com/login/device");
    links.open.mockClear();
    await act(async () => { link.click(); });
    expect(links.open).toHaveBeenCalledWith(GITHUB_DEVICE_PAGE);
    answers["GET /api/home/github"] = { login: "octocat", signIn: { phase: "done" } };
    await act(async () => { await vi.advanceTimersByTimeAsync(HOME_GITHUB_POLL_MS); });
    expect(state()).toBe("connected");
    expect(host.textContent).toContain("Connected as @octocat");
    expect(button("Disconnect")).toBeTruthy();
  });

  it("disconnects", async () => {
    answers["GET /api/home/github"] = { login: "octocat", signIn: idle };
    await show();
    answers["POST /api/home/github/disconnect"] = { login: null, signIn: idle };
    await act(async () => { button("Disconnect")!.click(); });
    expect(fetches.at(-1)).toEqual({ path: "/api/home/github/disconnect", method: "POST" });
    expect(state()).toBe("disconnected");
    expect(button("Connect")).toBeTruthy();
  });

  it("shows why it failed and keeps Connect", async () => {
    await show();
    answers["POST /api/home/github/connect"] = { login: null, signIn: { phase: "failed", detail: "gh could not start: spawn gh ENOENT" } };
    await act(async () => { button("Connect")!.click(); });
    expect(links.open).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("ENOENT");
    expect(button("Connect")).toBeTruthy();
    answers["POST /api/home/github/connect"] = new Error("Only the owner of this My Cloud can connect GitHub.");
    await act(async () => { button("Connect")!.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Only the owner of this My Cloud can connect GitHub.");
  });

  it("never opens a page other than GitHub's device page", async () => {
    await show();
    answers["POST /api/home/github/connect"] = { login: null, signIn: { ...waiting, url: "https://evil.example/login/device" } };
    await act(async () => { button("Connect")!.click(); });
    expect(links.open).not.toHaveBeenCalled();
  });
});
