import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_SITE_ASSOCIATION_PATH,
  APPLE_TEAM_ID,
  PHONE_APP_ID,
  PHONE_APP_STORE_ID,
  appSiteAssociation,
  appSiteAssociationResponse,
} from "./apple-app.ts";

const repo = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function opensApp(path: string): boolean {
  const components = appSiteAssociation("home").applinks!.details[0]!.components;
  for (const component of components) {
    const pattern = new RegExp(`^${component["/"].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    if (pattern.test(path)) return component.exclude !== true;
  }
  return false;
}

describe("the iPhone app's Apple identifiers", () => {
  it("name the team the Mac app is signed with and the store id the web page advertises", () => {
    expect(repo("docs/laterdog/releasing.md")).toContain(`(${APPLE_TEAM_ID})`);
    expect(repo("index.html")).toContain(`content="app-id=${PHONE_APP_STORE_ID}"`);
    expect(PHONE_APP_ID).toBe("5JAPUBC2B6.dog.later.phone");
  });
});

describe("the app-site association for a home", () => {
  it("hands the home's pages to the iPhone app and keeps the web-only paths in the browser", () => {
    expect(appSiteAssociation("home")).toMatchObject({
      applinks: { details: [{ appIDs: [PHONE_APP_ID] }] },
      webcredentials: { apps: [PHONE_APP_ID] },
    });
    for (const path of ["/", "/chat/abc", "/settings"]) expect(opensApp(path), path).toBe(true);
    for (const path of [
      "/api/health",
      "/hooks/github",
      "/.well-known/apple-app-site-association",
      "/assets/index-abc.js",
      "/pair",
      "/desktop-viewer",
      "/laterdog.svg",
      "/manifest.webmanifest",
    ]) expect(opensApp(path), path).toBe(false);
  });

  it("claims no pages on the service hosts, only saved credentials", () => {
    expect(appSiteAssociation("service")).toEqual({ webcredentials: { apps: [PHONE_APP_ID] } });
  });
});

describe("the app-site association response", () => {
  const url = `https://h1234-home.later.dog${APP_SITE_ASSOCIATION_PATH}`;

  it("answers GET with JSON that has no redirect and no sign-in", async () => {
    const response = appSiteAssociationResponse(new Request(url), "home")!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual(appSiteAssociation("home"));
  });

  it("answers HEAD with the headers only and refuses other methods", async () => {
    const head = appSiteAssociationResponse(new Request(url, { method: "HEAD" }), "home")!;
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json");
    expect(await head.text()).toBe("");
    const post = appSiteAssociationResponse(new Request(url, { method: "POST" }), "home")!;
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("ignores every other path, even one that only starts the same way", () => {
    for (const path of ["/", "/.well-known/apple-app-site-association/x", "/.well-known/assetlinks.json", "/apple-app-site-association"]) {
      expect(appSiteAssociationResponse(new Request(`https://h1234-home.later.dog${path}`), "home"), path).toBeNull();
    }
  });
});
