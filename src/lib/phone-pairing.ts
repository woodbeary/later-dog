export function pairingCodesOn(config: unknown): boolean {
  const membership = config && typeof config === "object" ? (config as { membership?: unknown }).membership : undefined;
  return !(membership && typeof membership === "object" && (membership as { pairingCodes?: unknown }).pairingCodes === false);
}

export function takePhoneAppRequest(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("desktop-settings") !== "phone") return null;
  url.searchParams.delete("desktop-settings");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function pairedDestination(search: string): string {
  return new URLSearchParams(search).get("desktop-settings") === "phone" ? "/?desktop-settings=phone" : "/";
}
