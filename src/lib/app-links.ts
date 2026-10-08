// The handful of outward links the app offers from the profile menu and the
// About dialog. They are collected here so "where does Help go?" has one
// answer rather than one per call site. Every link points at this project's
// own repository: later.dog has no website, paid plan or phone app yet, so
// nothing here sends anyone to a store page or to another project's servers.
export const APP_NAME = "later.dog";
export const APP_REPOSITORY = "https://github.com/woodbeary/later-dog";
/** The later.dog docs tree is the help centre: one destination, not two. */
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs/laterdog`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
/** Feedback goes to the issue tracker; there is no community chat to send it to. */
export const FEEDBACK_URL = `${APP_REPOSITORY}/issues`;
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;
/** Sponsorship and where the money goes (a share to animal rescue, ledger published there). One link, no nags. */
export const SUPPORT_URL = `${APP_REPOSITORY}/blob/main/docs/laterdog/support.md`;

/** The version Vite inlined from package.json; "dev" when the define is
 * missing (a bare `tsc`/test run outside the bundler). */
export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** "macOS", "Windows", "Linux" — or nothing at all in the browser, where the
 * host OS is not ours to claim. */
export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

/** Hands a link to the default browser through the preload bridge, falling
 * back to a new tab when the app runs in a plain browser. */
export async function openExternalLink(url: string): Promise<void> {
  if (window.laterdog?.openExternal) {
    await window.laterdog.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
