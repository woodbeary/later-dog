import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { LocaleKey } from "@/locales";
import { cloudPlanView } from "./cloud-plan";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "./session";

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

export function pairingCodesOn(config: unknown): boolean {
  const membership = config && typeof config === "object" ? (config as { membership?: unknown }).membership : undefined;
  return !(membership && typeof membership === "object" && (membership as { pairingCodes?: unknown }).pairingCodes === false);
}

export interface PhonePairingAccess {
  session: SessionState | null;
  pairingCodes: boolean;
}

export interface ConnectPhoneEntry {
  target: PhonePairingTarget;
  subtitleKey: LocaleKey;
}

const SUBTITLE: Record<PhonePairingTarget, LocaleKey> = {
  computer: "sidebar.menu.connectPhone.computer",
  cloud: "sidebar.menu.connectPhone.cloud",
  server: "sidebar.menu.connectPhone.server",
};

/** The menu entry, or null when this window cannot pair a phone. This
 * computer's own phone flow is always there. A server's pairing code is
 * offered only to the owner on that machine or an admin session, and only
 * where pairing codes are on; while that answer is on its way
 * (`access` null), nothing is offered. */
export function connectPhoneEntry(target: PhonePairingTarget, access: PhonePairingAccess | null): ConnectPhoneEntry | null {
  if (target !== "computer" && !(access && access.pairingCodes && isOwnerOrAdmin(access.session))) return null;
  return { target, subtitleKey: SUBTITLE[target] };
}

/** The person's own Cloud, as a second destination on this computer:
 * "ready" (a paid plan, any tier, and the Cloud Ready: offered first),
 * "not-ready" (paid, but the Cloud is setting up, stopped or unlisted: a
 * hint only), or null (no paid plan, signed out, or not known yet). Read
 * from the verified native snapshot only. */
export type CloudPhoneDestination = "ready" | "not-ready" | null;

export function cloudPhoneDestination(account: CloudAccountState | null | undefined): CloudPhoneDestination {
  if (cloudPlanView(account).kind !== "paid") return null;
  return account?.status === "connected" && account.machine?.status === "ready" ? "ready" : "not-ready";
}

export interface PhoneDestination extends ConnectPhoneEntry {
  id: "cloud" | "here";
  /** a quiet third line: why the Cloud is not offered yet */
  noteKey?: LocaleKey;
}

/** The lines "Connect your phone" offers, in order. Only on this computer
 * does the person's Cloud join in, and first; on the Cloud itself, or any
 * other server, the window's own pairing is the only one. */
export function phoneDestinations(entry: ConnectPhoneEntry | null, cloud: CloudPhoneDestination): PhoneDestination[] {
  if (!entry) return [];
  const here: PhoneDestination = { ...entry, id: "here" };
  if (entry.target !== "computer" || !cloud) return [here];
  if (cloud === "not-ready") return [{ ...here, noteKey: "sidebar.menu.connectPhone.cloudNotReady" }];
  return [{ id: "cloud", target: "cloud", subtitleKey: "sidebar.menu.connectPhone.cloudAlwaysOn" }, here];
}

let pending: Promise<PhonePairingAccess> | null = null;

export function loadPhonePairingAccess(fetchImpl: typeof fetch = fetch): Promise<PhonePairingAccess> {
  pending ??= readSessionState(fetchImpl).then(async (session): Promise<PhonePairingAccess> => {
    if (!isOwnerOrAdmin(session)) return { session, pairingCodes: false };
    const config: unknown = await fetchImpl("/api/config", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    return { session, pairingCodes: pairingCodesOn(config) };
  });
  return pending;
}

/** Tests only: forget the answer so the next load asks again. */
export function resetPhonePairingAccess(): void {
  pending = null;
}

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
