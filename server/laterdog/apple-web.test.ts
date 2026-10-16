import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { PHONE_APP_STORE_ID } from "../../shared/apple-app.ts";
import { advertisesPhoneApp, pageAddress, pageVisit, smartAppBanner, visitorPage, type PageVisit } from "./apple-web.ts";

const INDEX = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) later.dog/0.3.41 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36";

const home = (overrides: Partial<PageVisit> = {}): PageVisit => ({
  cloudHome: true,
  host: "h1234-home.later.dog",
  origin: "https://h1234-home.later.dog",
  path: "/",
  userAgent: SAFARI,
  ...overrides,
});

const banner = (html: string) => /<meta name="apple-itunes-app"[^>]*>/.exec(html)?.[0] ?? null;

describe("the Smart App Banner on the page a home serves", () => {
  it("is in the page the renderer is built from, with the store id and no address yet", () => {
    expect(banner(INDEX)).toBe(`<meta name="apple-itunes-app" content="app-id=${PHONE_APP_STORE_ID}" />`);
  });

  it("carries the page the person is on, so the app opens the same home", () => {
    expect(banner(visitorPage(INDEX, home()))).toBe(
      `<meta name="apple-itunes-app" content="app-id=${PHONE_APP_STORE_ID}, app-argument=https://h1234-home.later.dog/" />`,
    );
    expect(banner(visitorPage(INDEX, home({ path: "/index.html" })))).toContain("app-argument=https://h1234-home.later.dog/\"");
    expect(banner(visitorPage(INDEX, home({ path: "/pair" })))).toContain("app-argument=https://h1234-home.later.dog/pair\"");
  });

  it("changes nothing else in the page", () => {
    const served = visitorPage(INDEX, home());
    expect(served.replace(banner(served)!, banner(INDEX)!)).toBe(INDEX);
  });

  it("never reaches the desktop app, a local address, or a server that is not a Cloud home", () => {
    expect(banner(visitorPage(INDEX, home({ userAgent: DESKTOP })))).toBeNull();
    expect(banner(visitorPage(INDEX, home({ host: "127.0.0.1:8799", origin: "http://127.0.0.1:8799" })))).toBeNull();
    expect(banner(visitorPage(INDEX, home({ host: "localhost:5199" })))).toBeNull();
    expect(banner(visitorPage(INDEX, home({ cloudHome: false })))).toBeNull();
    expect(visitorPage(INDEX, home({ userAgent: DESKTOP }))).toBe(INDEX.replace(/[ \t]*<meta name="apple-itunes-app"[^>]*>\n/, ""));
  });

  it("leaves a page with no banner alone", () => {
    const plain = "<!doctype html><title>later.dog</title>";
    expect(visitorPage(plain, home())).toBe(plain);
    expect(visitorPage(plain, home({ userAgent: DESKTOP }))).toBe(plain);
  });

  it("keeps a hostile address inside the attribute and a comma out of the argument", () => {
    expect(smartAppBanner('https://x.test/"><script>alert(1)</script>')).not.toContain("<script>");
    expect(pageAddress(home({ path: "/a,b" }))).toBe("https://h1234-home.later.dog/a%2Cb");
    expect(pageAddress(home({ origin: null }))).toBeNull();
    expect(smartAppBanner(null)).toBe(`<meta name="apple-itunes-app" content="app-id=${PHONE_APP_STORE_ID}" />`);
  });

  it("reads the visit from the request the proxy forwarded", () => {
    const request = { headers: { host: "H1234-home.later.dog", "x-forwarded-proto": "https", "user-agent": SAFARI } } as unknown as IncomingMessage;
    const visit = pageVisit(request, "/", true);
    expect(visit).toEqual(home({ host: "H1234-home.later.dog" }));
    expect(advertisesPhoneApp(visit)).toBe(true);
    const bare = pageVisit({ headers: {} } as IncomingMessage, "/", true);
    expect(bare).toMatchObject({ host: undefined, origin: null, userAgent: undefined });
  });
});
