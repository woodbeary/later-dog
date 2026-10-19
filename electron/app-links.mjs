import { APP_LINK_SCHEMES, appLinkLogLabel, parseAppLink } from "./app-link.mjs";

export const APP_LINK_CHANNEL = "app:link";
export const APP_LINKS_READY_CHANNEL = "app-links:ready";

export function createAppLinks({ reveal = () => {}, log = () => {}, otherHosts = [] } = {}) {
  const ours = value => {
    const label = appLinkLogLabel(value);
    return APP_LINK_SCHEMES.some(scheme => label.startsWith(`${scheme}://`)) && !otherHosts.some(host => label.endsWith(`://${host}`));
  };
  let pending = null;
  let receiver = null;
  let navigatingAway = false;

  function live() {
    if (!receiver || navigatingAway) return null;
    try {
      if (receiver.isDestroyed()) receiver = null;
    } catch {
      receiver = null;
    }
    return receiver;
  }

  function flush() {
    const target = live();
    if (!pending || !target) return false;
    const link = pending;
    pending = null;
    try {
      target.send(APP_LINK_CHANNEL, link.canonical);
      log(`app link opened: ${link.label}`);
      return true;
    } catch (error) {
      pending = link;
      log(`app link not delivered: ${link.label} ${error?.message ?? "send failed"}`);
      return false;
    }
  }

  function accept(raw) {
    const parsed = parseAppLink(raw);
    const label = appLinkLogLabel(raw);
    if (!parsed.ok) {
      if (parsed.reason !== "scheme") log(`app link ignored: ${label} ${parsed.reason}`);
      return false;
    }
    pending = { canonical: parsed.canonical, label };
    if (!live()) log(`app link held: ${label}`);
    reveal();
    flush();
    return true;
  }

  return {
    accept,
    fromArgs(argv) {
      if (!Array.isArray(argv)) return false;
      for (let index = argv.length - 1; index >= 0; index--) {
        if (parseAppLink(argv[index]).ok) return accept(argv[index]);
      }
      const broken = argv.findLast(ours);
      if (broken !== undefined) accept(broken);
      return false;
    },
    ready(contents) {
      receiver = contents ?? null;
      navigatingAway = false;
      return flush();
    },
    navigating(contents) {
      if (receiver && receiver === contents) navigatingAway = true;
    },
    stayed(contents) {
      if (!receiver || receiver !== contents || !navigatingAway) return false;
      navigatingAway = false;
      return flush();
    },
    notReady(contents) {
      if (receiver && receiver === contents) {
        receiver = null;
        navigatingAway = false;
      }
    },
    pending: () => pending?.canonical ?? null,
  };
}
