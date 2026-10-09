// "Connect your phone": one entry in the profile menu, only where this
// window can pair a phone. That is the desktop app on its own computer: the
// entry opens the pairing flow (PhonePairingDialog), which pairs with this
// computer's companion. A Cloud or another server paired phones from
// Settings → Remote access, which is gone, so their windows offer only Use on
// your phone.

export type PhonePairingTarget = "computer" | "cloud" | "server";

/** This window's target, from the bridges it has and the server it shows.
 * The desktop's phone bridge is only on the local app's own page, never a
 * remote server's (the preload withholds it there). */
export function currentPhonePairingTarget(cloudHome: boolean): PhonePairingTarget {
  // SAFETY: the preload's narrow bridge; `companion` is read for presence only.
  const laterdog = typeof window === "undefined" ? undefined : (window.laterdog as { companion?: unknown; remoteClient?: { active?: boolean } } | undefined);
  return phonePairingTarget({ companion: Boolean(laterdog?.companion), remoteClient: laterdog?.remoteClient?.active === true, cloudHome });
}

/** Where a phone pairs from this window. `companion`: this window has the
 * desktop's phone bridge (the local app, not a remote server's page);
 * `remoteClient`: this desktop is a client of another server, whose phones
 * pair there; `cloudHome`: the server is a later.dog Cloud home. */
export function phonePairingTarget(input: { companion: boolean; remoteClient: boolean; cloudHome: boolean }): PhonePairingTarget {
  if (input.cloudHome) return "cloud";
  return input.companion && !input.remoteClient ? "computer" : "server";
}

/** `?desktop-settings=phone`: once asked Settings to open on the phone
 * pairing, which is gone; main still adds it when it opens the Cloud in this
 * window, so the app only takes it off the address. Returns the address
 * without it, or null when it is not there. */
export function takePhonePairingRequest(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("desktop-settings") !== "phone") return null;
  url.searchParams.delete("desktop-settings");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where the pair page goes once this device is paired: home, carrying on
 * only that one request, so a first visit to the Cloud still ends on its
 * phone pairing. */
export function pairedDestination(search: string): string {
  return new URLSearchParams(search).get("desktop-settings") === "phone" ? "/?desktop-settings=phone" : "/";
}
