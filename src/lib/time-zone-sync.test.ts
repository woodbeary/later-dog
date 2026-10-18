// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deviceTimeZone,
  readHomeTimeZone,
  syncHomeTimeZone,
  useTimeZoneSync,
  zoneLabel,
  zoneToSave,
  type SyncedZoneMemory,
} from "./time-zone-sync";

type Session = { kind: "session"; id: string; scopes: string[] } | { kind: "loopback" };

function home(
  state: { timeZone: string; saved: string | null },
  { putStatus = 200, session = { kind: "loopback" } as Session }: { putStatus?: number; session?: Session } = {},
) {
  const calls: Array<{ method: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/session") return new Response(JSON.stringify(session), { status: 200 });
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as { timeZone: string } : undefined;
    calls.push({ method, ...(body ? { body } : {}) });
    if (method === "PUT") {
      if (putStatus !== 200) return new Response(JSON.stringify({ error: "Only the owner can change the home's time zone." }), { status: putStatus });
      state.timeZone = body!.timeZone;
      state.saved = body!.timeZone;
    }
    return new Response(JSON.stringify(state), { status: 200 });
  });
  return { state, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function memory(start: string | null = null): SyncedZoneMemory & { value: string | null } {
  return {
    value: start,
    read() { return this.value; },
    write(zone) { this.value = zone; },
  };
}

describe("following this computer's time zone", () => {
  it("saves the computer's zone on a home that has none saved", async () => {
    const cloud = home({ timeZone: "UTC", saved: null });
    const synced = memory();
    await expect(syncHomeTimeZone("Asia/Kolkata", synced, cloud.fetchImpl)).resolves.toEqual({ timeZone: "Asia/Kolkata", saved: "Asia/Kolkata" });
    expect(cloud.calls).toEqual([{ method: "GET" }, { method: "PUT", body: { timeZone: "Asia/Kolkata" } }]);
    expect(synced.value).toBe("Asia/Kolkata");
  });

  it("only reads when the home already follows this zone", async () => {
    const cloud = home({ timeZone: "Asia/Kolkata", saved: "Asia/Kolkata" });
    await syncHomeTimeZone("Asia/Kolkata", memory(), cloud.fetchImpl);
    expect(cloud.calls).toEqual([{ method: "GET" }]);
  });

  it("keeps a zone the phone picked while this computer stays where it was", async () => {
    const cloud = home({ timeZone: "Asia/Tokyo", saved: "Asia/Tokyo" });
    const synced = memory("America/Los_Angeles");
    await expect(syncHomeTimeZone("America/Los_Angeles", synced, cloud.fetchImpl)).resolves.toMatchObject({ saved: "Asia/Tokyo" });
    expect(cloud.calls).toEqual([{ method: "GET" }]);
  });

  it("does not take over a zone the phone saved before this computer ever synced", async () => {
    const cloud = home({ timeZone: "Asia/Tokyo", saved: "Asia/Tokyo" });
    const synced = memory();
    await syncHomeTimeZone("America/Los_Angeles", synced, cloud.fetchImpl);
    expect(cloud.calls).toEqual([{ method: "GET" }]);
    expect(synced.value).toBe("America/Los_Angeles");
  });

  it("saves the new zone when this computer itself moves", async () => {
    const cloud = home({ timeZone: "Asia/Tokyo", saved: "Asia/Tokyo" });
    const synced = memory("America/Los_Angeles");
    await expect(syncHomeTimeZone("America/New_York", synced, cloud.fetchImpl)).resolves.toMatchObject({ saved: "America/New_York" });
    expect(synced.value).toBe("America/New_York");
  });

  it("decides from the saved zone, this computer's zone and the last one it synced", () => {
    expect(zoneToSave({ timeZone: "UTC", saved: null }, "Asia/Kolkata", null)).toBe("Asia/Kolkata");
    expect(zoneToSave({ timeZone: "UTC", saved: null }, "Asia/Kolkata", "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneToSave({ timeZone: "Asia/Kolkata", saved: "Asia/Kolkata" }, "Asia/Kolkata", null)).toBeNull();
    expect(zoneToSave({ timeZone: "Asia/Tokyo", saved: "Asia/Tokyo" }, "Asia/Kolkata", null)).toBeNull();
    expect(zoneToSave({ timeZone: "Asia/Tokyo", saved: "Asia/Tokyo" }, "Asia/Kolkata", "Asia/Kolkata")).toBeNull();
    expect(zoneToSave({ timeZone: "Asia/Tokyo", saved: "Asia/Tokyo" }, "Asia/Kolkata", "Europe/Paris")).toBe("Asia/Kolkata");
  });

  it("leaves the home alone when it refuses the change or cannot be read", async () => {
    const guest = home({ timeZone: "UTC", saved: null }, { putStatus: 403 });
    const synced = memory();
    await expect(syncHomeTimeZone("Asia/Kolkata", synced, guest.fetchImpl)).resolves.toEqual({ timeZone: "UTC", saved: null });
    expect(synced.value).toBeNull();
    const down = vi.fn(async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(syncHomeTimeZone("Asia/Kolkata", synced, down)).resolves.toBeNull();
    expect(down).toHaveBeenCalledTimes(1);
    await expect(syncHomeTimeZone(null, synced, down)).resolves.toBeNull();
    expect(down).toHaveBeenCalledTimes(1);
    expect(synced.value).toBeNull();
  });

  it("reads the zone the home runs in and names it in plain words", async () => {
    await expect(readHomeTimeZone(home({ timeZone: "America/Los_Angeles", saved: null }).fetchImpl)).resolves.toEqual({ timeZone: "America/Los_Angeles", saved: null });
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("America / Argentina / Buenos Aires");
    expect(zoneLabel("UTC")).toBe("UTC");
  });
});

describe("the app keeping the home on this computer's zone", () => {
  const here = deviceTimeZone() ?? "UTC";
  const [elsewhere, before] = ["Asia/Tokyo", "Europe/Paris", "Pacific/Auckland"].filter((zone) => zone !== here);
  let root: Root | null = null;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

  function Probe({ connection, synced, fetchImpl }: { connection: string | null; synced: SyncedZoneMemory; fetchImpl: typeof fetch }) {
    useTimeZoneSync(connection, synced, fetchImpl);
    return null;
  }

  async function show(connection: string | null, synced: SyncedZoneMemory, fetchImpl: typeof fetch) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    flushSync(() => root!.render(createElement(Probe, { connection, synced, fetchImpl })));
    await settle();
  }

  afterEach(() => {
    root?.unmount();
    root = null;
  });

  it("does not undo the phone's zone when the app reconnects", async () => {
    const cloud = home({ timeZone: elsewhere, saved: elsewhere });
    const synced = memory(here);
    await show("cloud", synced, cloud.fetchImpl);
    await show(null, synced, cloud.fetchImpl);
    await show("cloud", synced, cloud.fetchImpl);
    expect(cloud.calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(cloud.calls.filter((call) => call.method === "PUT")).toEqual([]);
    expect(cloud.state.saved).toBe(elsewhere);
  });

  it("saves this computer's zone on a home with none and checks it again only after a reconnect", async () => {
    const cloud = home({ timeZone: "UTC", saved: null });
    const synced = memory();
    await show("cloud", synced, cloud.fetchImpl);
    expect(cloud.calls).toEqual([{ method: "GET" }, { method: "PUT", body: { timeZone: here } }]);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(cloud.calls).toHaveLength(2);
    await show(null, synced, cloud.fetchImpl);
    await show("cloud", synced, cloud.fetchImpl);
    expect(cloud.calls).toEqual([{ method: "GET" }, { method: "PUT", body: { timeZone: here } }, { method: "GET" }]);
  });

  it("saves this computer's zone once it has moved since the last sync", async () => {
    const cloud = home({ timeZone: elsewhere, saved: elsewhere });
    await show("cloud", memory(before), cloud.fetchImpl);
    expect(cloud.calls.filter((call) => call.method === "PUT")).toEqual([{ method: "PUT", body: { timeZone: here } }]);
  });

  it("never writes for a guest or while disconnected", async () => {
    const guest = home({ timeZone: "UTC", saved: null }, { session: { kind: "session", id: "guest", scopes: ["chat"] } });
    await show(null, memory(), guest.fetchImpl);
    await show("cloud", memory(), guest.fetchImpl);
    expect(guest.calls).toEqual([]);
  });
});
