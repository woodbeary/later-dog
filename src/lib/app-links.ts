export const APP_NAME = "later.dog";
export const APP_REPOSITORY = "https://github.com/woodbeary/later-dog";
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs/laterdog`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
export const FEEDBACK_URL = `${APP_REPOSITORY}/issues`;
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;
export const SUPPORT_URL = `${APP_REPOSITORY}/blob/main/docs/laterdog/support.md`;

export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

export async function openExternalLink(url: string): Promise<void> {
  if (window.laterdog?.openExternal) {
    await window.laterdog.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
