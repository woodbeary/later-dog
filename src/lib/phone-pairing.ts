import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { LocaleKey } from "@/locales";
import { cloudPlanView } from "./cloud-plan";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "./session";

export type PhonePairingTarget = "computer" | "cloud" | "server";

export function currentPhonePairingTarget(cloudHome: boolean): PhonePairingTarget {
  const laterdog = typeof window === "undefined" ? undefined : (window.laterdog as { companion?: unknown; remoteClient?: { active?: boolean } } | undefined);
  return phonePairingTarget({ companion: Boolean(laterdog?.companion), remoteClient: laterdog?.remoteClient?.active === true, cloudHome });
}

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

export function connectPhoneEntry(target: PhonePairingTarget, access: PhonePairingAccess | null): ConnectPhoneEntry | null {
  if (target !== "computer" && !(access && access.pairingCodes && isOwnerOrAdmin(access.session))) return null;
  return { target, subtitleKey: SUBTITLE[target] };
}

export type CloudPhoneDestination = "ready" | "not-ready" | null;

export function cloudPhoneDestination(account: CloudAccountState | null | undefined): CloudPhoneDestination {
  if (cloudPlanView(account).kind !== "paid") return null;
  return account?.status === "connected" && account.machine?.status === "ready" ? "ready" : "not-ready";
}

export interface PhoneDestination extends ConnectPhoneEntry {
  id: "cloud" | "here";
  noteKey?: LocaleKey;
}

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

export function resetPhonePairingAccess(): void {
  pending = null;
}

export function takePhonePairingRequest(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("desktop-settings") !== "phone") return null;
  url.searchParams.delete("desktop-settings");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function pairedDestination(search: string): string {
  return new URLSearchParams(search).get("desktop-settings") === "phone" ? "/?desktop-settings=phone" : "/";
}
