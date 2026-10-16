// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerAddress, bannerContent, followThemeColor, keepSmartAppBannerCurrent, syncAppTitle, syncSmartAppBanner, syncThemeColor } from "./safari-chrome";

function head(html: string): void {
  document.head.innerHTML = html;
}

const place = (origin: string, pathname: string) => ({ origin, pathname });

function visitor(location: { origin: string; pathname: string }, desktop = false) {
  const listeners = new Map<string, () => void>();
  const win = {
    location,
    ...(desktop ? { laterdog: {} } : {}),
    addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
    removeEventListener: (type: string) => void listeners.delete(type),
  } as unknown as Window;
  return { win, listeners };
}

beforeEach(() => {
  head("");
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-skin");
});

afterEach(() => {
  head("");
});

describe("the Smart App Banner in the browser", () => {
  it("names the page the person is on, keeping the app id the page was served with", () => {
    expect(bannerAddress(place("https://h1-home.later.dog", "/"))).toBe("https://h1-home.later.dog/");
    expect(bannerAddress(place("https://h1-home.later.dog", "/index.html"))).toBe("https://h1-home.later.dog/");
    expect(bannerAddress(place("https://h1-home.later.dog", "/a,b"))).toBe("https://h1-home.later.dog/a%2Cb");
    expect(bannerContent("app-id=6822519577", "https://x.test/")).toBe("app-id=6822519577, app-argument=https://x.test/");
    expect(bannerContent("app-id=6822519577, app-argument=https://old.test/", "https://x.test/")).toBe("app-id=6822519577, app-argument=https://x.test/");
    expect(bannerContent("something else", "https://x.test/")).toBe("something else");
  });

  it("follows the page when the history moves", () => {
    head('<meta name="apple-itunes-app" content="app-id=6822519577" />');
    const location = place("https://h1-home.later.dog", "/");
    const { win, listeners } = visitor(location);
    const stop = keepSmartAppBannerCurrent(document, win);
    const content = () => document.querySelector("meta[name=apple-itunes-app]")?.getAttribute("content");
    expect(content()).toBe("app-id=6822519577, app-argument=https://h1-home.later.dog/");
    location.pathname = "/pair";
    listeners.get("popstate")?.();
    expect(content()).toBe("app-id=6822519577, app-argument=https://h1-home.later.dog/pair");
    stop();
    expect([...listeners.keys()]).toEqual([]);
  });

  it("is removed inside the desktop app and ignored when the page has none", () => {
    head('<meta name="apple-itunes-app" content="app-id=6822519577" />');
    syncSmartAppBanner(document, visitor(place("http://127.0.0.1:8799", "/"), true).win);
    expect(document.querySelector("meta[name=apple-itunes-app]")).toBeNull();
    expect(() => syncSmartAppBanner(document, visitor(place("https://h1-home.later.dog", "/")).win)).not.toThrow();
    expect(document.querySelector("meta[name=apple-itunes-app]")).toBeNull();
  });
});

describe("the colour Safari paints around the page", () => {
  const colours = () => [...document.querySelectorAll("meta[name=theme-color]")].map((tag) => [tag.getAttribute("content"), tag.getAttribute("media")]);

  it("becomes one tag with the skin's background, replacing the light and dark guesses", () => {
    head('<meta name="theme-color" content="#fcfcfc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#070707" media="(prefers-color-scheme: dark)">');
    document.documentElement.style.setProperty("--color-app", "#f3efe6");
    syncThemeColor(document);
    expect(colours()).toEqual([["#f3efe6", null]]);
  });

  it("adds the tag when the page has none and leaves it alone when the skin has no background", () => {
    syncThemeColor(document);
    expect(colours()).toEqual([]);
    document.documentElement.style.setProperty("--color-app", "#070707");
    syncThemeColor(document);
    expect(colours()).toEqual([["#070707", null]]);
  });

  it("repaints when the skin changes", async () => {
    document.documentElement.style.setProperty("--color-app", "#fcfcfc");
    const stop = followThemeColor(document);
    expect(colours()).toEqual([["#fcfcfc", null]]);
    document.documentElement.style.setProperty("--color-app", "#070707");
    document.documentElement.dataset.skin = "midnight";
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(colours()).toEqual([["#070707", null]]);
    stop();
  });
});

describe("the name under the home-screen icon", () => {
  it("follows the brand", () => {
    head('<meta name="apple-mobile-web-app-title" content="later.dog">');
    syncAppTitle("Reliable Platform", document);
    expect(document.querySelector("meta[name=apple-mobile-web-app-title]")?.getAttribute("content")).toBe("Reliable Platform");
    head("");
    expect(() => syncAppTitle("Reliable Platform", document)).not.toThrow();
  });
});
