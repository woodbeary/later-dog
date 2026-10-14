import { deepLink, variant } from "./app-variant.mjs";

export const CLOUD_DEEP_LINK = deepLink(variant, "cloud");

export const isCloudDeepLink = value => value === CLOUD_DEEP_LINK;
export function takeCloudDeepLink(argv) {
  let found = false;
  for (let index = argv.length - 1; index >= 0; index--) {
    if (!isCloudDeepLink(argv[index])) continue;
    argv.splice(index, 1);
    found = true;
  }
  return found;
}

export function createCloudEntry({ reveal, open }) {
  let pending = false, ready = false;
  async function deliver() {
    if (!ready || !pending) return false;
    pending = false;
    try { return await open(); } catch { return false; }
  }
  function request() {
    pending = true;
    reveal();
    void deliver();
    return true;
  }
  return {
    fromLaunch(argv) {
      if (takeCloudDeepLink(argv)) pending = true;
      return pending;
    },
    fromArgs: argv => takeCloudDeepLink(argv) && request(),
    fromUrl: url => isCloudDeepLink(url) && request(),
    ready() {
      ready = true;
      return deliver();
    },
  };
}
