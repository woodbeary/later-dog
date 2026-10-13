import { describe, expect, it } from "vitest";
import { BUSY_RETRY_SECONDS, isBackground, LENDING_HEADER, startFailure, WAKE_HEADER, wakeResponse, WAKING_RETRY_SECONDS } from "../src/waking.ts";

const api = (accept = "application/json") => new Request("https://h1-home.later.dog/api/bots", { headers: { accept } });

describe("a home that is still waking up", () => {
  it("tells the phone to wait a moment and try again", async () => {
    const response = wakeResponse(api(), "waking");
    expect(response.status).toBe(503);
    expect(response.headers.get(WAKE_HEADER)).toBe("waking");
    expect(response.headers.get("retry-after")).toBe(String(WAKING_RETRY_SECONDS));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "waking", retryAfter: WAKING_RETRY_SECONDS });
  });

  it("shows the desktop window a page that reloads itself", async () => {
    const response = wakeResponse(new Request("https://h1-home.later.dog/", { headers: { accept: "text/html,application/xhtml+xml" } }), "waking");
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`<meta http-equiv="refresh" content="${WAKING_RETRY_SECONDS}">`);
    expect(html).toContain("Waking up My Cloud…");
  });

  it("answers streams and other requests with JSON, never the page", async () => {
    expect(wakeResponse(api("text/event-stream"), "waking").headers.get("content-type")).toContain("application/json");
    const post = new Request("https://h1-home.later.dog/api/bots", { method: "POST", headers: { accept: "text/html" } });
    expect(wakeResponse(post, "waking").headers.get("content-type")).toContain("application/json");
  });

  it("says busy, with a longer wait, when Cloudflare has no container free", async () => {
    const response = wakeResponse(api(), "busy");
    expect(response.headers.get(WAKE_HEADER)).toBe("busy");
    expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_SECONDS));
    expect(startFailure(new Error("there is no container instance that can be provided to this durable object"))).toBe("busy");
    expect(startFailure(new Error("you are requesting too many containers per second"))).toBe("busy");
    expect(startFailure(new Error("the container is not listening"))).toBe("waking");
    expect(startFailure("boom")).toBe("waking");
  });
});

describe("a Mac lending to a home", () => {
  it("is background traffic that must not wake the home or keep it awake", () => {
    expect(isBackground(new Request("https://h1-home.later.dog/api/shared-computers/abc/poll", { method: "POST", headers: { [LENDING_HEADER]: "1" } }))).toBe(true);
    expect(isBackground(new Request("https://h1-home.later.dog/api/auth/session", { headers: { [LENDING_HEADER]: "1" } }))).toBe(true);
    expect(isBackground(new Request("https://h1-home.later.dog/api/auth/session"))).toBe(false);
    expect(isBackground(new Request("https://h1-home.later.dog/api/events", { headers: { [LENDING_HEADER]: "0" } }))).toBe(false);
  });
});
