import { CONNECT_MAC } from "./connect-mac.ts";

export const MAC_OFFLINE_RESULT = "The Mac isn't connected: the later.dog app isn't open on it. Tell the person in one line: \"Open the later.dog app on your Mac.\"";
export const MAC_PLACE = "mac";
export const MAC_LABEL = "Your Mac";
export const COMPUTER_RULE = "You have your own cloud computer. The person's Mac is also yours to use while it is online: use it when a task needs something only that Mac has (files in Downloads, Desktop or Documents, a local project folder, an app signed in there); otherwise use your own computer. Don't ask which one to use. If the person set that Mac to ask first, later.dog shows them a card and your call waits for the answer.";

export type KnownMac = { name: string; online: boolean };

export type MacOption = {
  surface: typeof MAC_PLACE;
  label: typeof MAC_LABEL;
  available: boolean;
  ready: boolean;
  canStart: false;
  canCreate: false;
  reason?: string;
};

export type MacSelectReply = { status: "ready" | "offline" | "none"; surface: typeof MAC_PLACE; message: string };

const ONLY_ON_THE_MAC = [
  /\b(downloads?|desktop|documents)\b/i,
  /\bmy (mac|laptop|computer)\b/i,
  /\b(local|on[- ]disk) (project|folder|repo|repository|checkout|files?)\b/i,
  /\bsigned[- ]in\b/i,
  /\b(this|the person'?s|their) mac\b/i,
  /~\//,
];

export function taskNeedsMac(needs: unknown): boolean {
  return typeof needs === "string" && ONLY_ON_THE_MAC.some(pattern => pattern.test(needs));
}

export function macOption(macs: readonly KnownMac[]): MacOption | null {
  if (macs.length === 0) return null;
  const online = macs.some(mac => mac.online);
  return {
    surface: MAC_PLACE, label: MAC_LABEL, available: online, ready: online, canStart: false, canCreate: false,
    ...(online ? {} : { reason: MAC_OFFLINE_RESULT }),
  };
}

export function macOptions(macs: readonly KnownMac[]): MacOption[] {
  const option = macOption(macs);
  return option ? [option] : [];
}

export function macSelectReply(requested: unknown, needs: unknown, macs: readonly KnownMac[]): MacSelectReply | null {
  const wanted = requested === MAC_PLACE || (requested === "auto" && taskNeedsMac(needs));
  if (!wanted) return null;
  if (macs.length === 0) return { status: "none", surface: MAC_PLACE, message: CONNECT_MAC };
  if (!macs.some(mac => mac.online)) return { status: "offline", surface: MAC_PLACE, message: MAC_OFFLINE_RESULT };
  return {
    status: "ready", surface: MAC_PLACE,
    message: "The Mac is online. Use shared_computer for its files, terminal and apps; no switch or approval is needed. Keep using your own cloud computer for everything else.",
  };
}

export function macOfflineResult() {
  return { content: [{ type: "text", text: MAC_OFFLINE_RESULT }] };
}

export function isMacOffline(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { macOffline?: unknown }).macOffline === true;
}
