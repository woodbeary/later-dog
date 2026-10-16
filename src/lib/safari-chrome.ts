const BANNER = 'meta[name="apple-itunes-app"]';
const THEME_COLOR = 'meta[name="theme-color"]';
const APP_TITLE = 'meta[name="apple-mobile-web-app-title"]';

export function bannerAddress(location: Pick<Location, "origin" | "pathname">): string {
  const path = location.pathname === "/index.html" ? "/" : location.pathname;
  return `${location.origin}${path}`.replace(/,/g, "%2C");
}

export function bannerContent(content: string, address: string): string {
  const id = /app-id=\d+/.exec(content)?.[0];
  return id ? `${id}, app-argument=${address}` : content;
}

export function syncSmartAppBanner(doc: Document = document, win: Window = window): void {
  const tag = doc.querySelector<HTMLMetaElement>(BANNER);
  if (!tag) return;
  if (win.laterdog) tag.remove();
  else tag.content = bannerContent(tag.content, bannerAddress(win.location));
}

export function keepSmartAppBannerCurrent(doc: Document = document, win: Window = window): () => void {
  const sync = () => syncSmartAppBanner(doc, win);
  sync();
  win.addEventListener("popstate", sync);
  win.addEventListener("pageshow", sync);
  return () => {
    win.removeEventListener("popstate", sync);
    win.removeEventListener("pageshow", sync);
  };
}

export function syncThemeColor(doc: Document = document): void {
  const color = getComputedStyle(doc.documentElement).getPropertyValue("--color-app").trim();
  if (!color) return;
  const [tag = doc.createElement("meta"), ...others] = doc.querySelectorAll<HTMLMetaElement>(THEME_COLOR);
  tag.name = "theme-color";
  tag.removeAttribute("media");
  tag.content = color;
  if (!tag.isConnected) doc.head.append(tag);
  for (const other of others) other.remove();
}

export function followThemeColor(doc: Document = document): () => void {
  syncThemeColor(doc);
  const observer = new MutationObserver(() => syncThemeColor(doc));
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  return () => observer.disconnect();
}

export function syncAppTitle(name: string, doc: Document = document): void {
  doc.querySelector<HTMLMetaElement>(APP_TITLE)?.setAttribute("content", name);
}
