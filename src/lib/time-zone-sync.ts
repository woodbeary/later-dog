import { useEffect } from "react";

import { isOwnerOrAdmin, readSessionState } from "./session";

export interface HomeTimeZone {
  timeZone: string;
  saved: string | null;
}

const ROUTE = "/api/time-zone";

export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function zoneLabel(zone: string): string {
  return zone.split("/").map((part) => part.replaceAll("_", " ")).join(" / ");
}

function homeTimeZoneFrom(body: unknown): HomeTimeZone | null {
  const record = Object(body) as { timeZone?: unknown; saved?: unknown };
  if (typeof record.timeZone !== "string" || !record.timeZone) return null;
  return { timeZone: record.timeZone, saved: typeof record.saved === "string" && record.saved ? record.saved : null };
}

export async function readHomeTimeZone(fetchImpl: typeof fetch = fetch): Promise<HomeTimeZone | null> {
  const res = await fetchImpl(ROUTE, { credentials: "same-origin" });
  if (!res.ok) return null;
  return homeTimeZoneFrom(await res.json().catch(() => null));
}

export interface SyncedZoneMemory {
  read(): string | null;
  write(zone: string): void;
}

const SYNCED_ZONE_KEY = "laterdog.timeZone.lastSynced";

export const browserSyncedZone: SyncedZoneMemory = {
  read() {
    try {
      return localStorage.getItem(SYNCED_ZONE_KEY) || null;
    } catch {
      return null;
    }
  },
  write(zone) {
    try {
      localStorage.setItem(SYNCED_ZONE_KEY, zone);
    } catch {}
  },
};

export function zoneToSave(home: HomeTimeZone, device: string, lastSynced: string | null): string | null {
  if (home.saved === device) return null;
  if (home.saved === null) return device;
  return lastSynced !== null && lastSynced !== device ? device : null;
}

export async function syncHomeTimeZone(
  zone: string | null,
  memory: SyncedZoneMemory,
  fetchImpl: typeof fetch = fetch,
): Promise<HomeTimeZone | null> {
  if (!zone) return null;
  const home = await readHomeTimeZone(fetchImpl);
  if (!home) return null;
  const next = zoneToSave(home, zone, memory.read());
  if (!next) {
    memory.write(zone);
    return home;
  }
  const res = await fetchImpl(ROUTE, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeZone: next }),
  });
  if (!res.ok) return home;
  memory.write(zone);
  return homeTimeZoneFrom(await res.json().catch(() => null)) ?? home;
}

export function useTimeZoneSync(
  connection: string | null,
  memory: SyncedZoneMemory = browserSyncedZone,
  fetchImpl: typeof fetch = fetch,
): void {
  useEffect(() => {
    if (!connection) return;
    let checked: string | null = null;
    let busy = false;
    let alive = true;
    const sync = () => {
      const zone = deviceTimeZone();
      if (!zone || zone === checked || busy) return;
      busy = true;
      void readSessionState(fetchImpl)
        .then((session) => alive && isOwnerOrAdmin(session) ? syncHomeTimeZone(zone, memory, fetchImpl) : null)
        .then((home) => { if (home) checked = zone; })
        .catch(() => {})
        .finally(() => { busy = false; });
    };
    sync();
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connection, memory, fetchImpl]);
}
