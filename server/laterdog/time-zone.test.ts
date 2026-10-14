import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext } from "../routes/table.ts";
import { applyTimeZone, createTimeZoneRoutes, isTimeZone, restoreTimeZone, savedTimeZone } from "./time-zone.ts";

const owner = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;

function call(handler: ReturnType<typeof createTimeZoneRoutes>, method: string, body?: unknown, path = "/api/time-zone") {
  const sent: { status?: number; body?: unknown } = {};
  const ctx = {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    url: new URL(`http://home${path}`),
    path,
    method,
    auth: owner,
    json: (_res: unknown, status: number, value: unknown) => {
      sent.status = status;
      sent.body = value;
    },
    readBody: async () => body,
  } as unknown as RouteContext;
  return handler(ctx).then((out) => ({ out, ...sent }));
}

describe("the home's time zone", () => {
  let folder: string;
  let file: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "laterdog-time-zone-"));
    file = join(folder, "time-zone.json");
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it("accepts real IANA zones only", () => {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+8"]) expect(isTimeZone(zone)).toBe(true);
    for (const zone of ["", " UTC", "Mars/Olympus_Mons", "../etc/passwd", "PST", "America/Los Angeles", 5, null, "A/".repeat(40)]) expect(isTimeZone(zone)).toBe(false);
  });

  it("restores the saved zone at startup and ignores anything damaged", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(restoreTimeZone(file, env)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, timeZone: "Europe/Berlin" }));
    expect(restoreTimeZone(file, env)).toBe("Europe/Berlin");
    expect(env.TZ).toBe("Europe/Berlin");
    writeFileSync(file, "{not json");
    expect(savedTimeZone(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ timeZone: "Nowhere/Land" }));
    expect(savedTimeZone(file)).toBeNull();
    const linked = join(folder, "linked.json");
    writeFileSync(join(folder, "real.json"), JSON.stringify({ timeZone: "Asia/Tokyo" }));
    symlinkSync(join(folder, "real.json"), linked);
    expect(savedTimeZone(linked)).toBeNull();
    expect(applyTimeZone("Europe/Berlin", env)).toBe(false);
    expect(applyTimeZone("Asia/Tokyo", env)).toBe(true);
  });

  it("saves a new zone from the owner and re-times routines once", async () => {
    const env: NodeJS.ProcessEnv = { TZ: "UTC" };
    const changed = vi.fn();
    const routes = createTimeZoneRoutes({ file, allowed: () => true, changed, env });
    expect((await call(routes, "GET")).status).toBe(200);
    expect(await call(routes, "PUT", { timeZone: "Nowhere/Land" })).toMatchObject({ status: 400 });
    expect(await call(routes, "PUT", { timeZone: "America/New_York" })).toMatchObject({ status: 200, body: { saved: "America/New_York" } });
    expect(env.TZ).toBe("America/New_York");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, timeZone: "America/New_York" });
    expect(changed).toHaveBeenCalledTimes(1);
    await call(routes, "PUT", { timeZone: "America/New_York" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await call(routes, "GET")).body).toMatchObject({ saved: "America/New_York" });
    expect((await call(routes, "DELETE")).status).toBe(405);
    expect((await call(routes, "GET", undefined, "/api/other")).out).toBe(PASS);
  });

  it("lets only the owner change it", async () => {
    const changed = vi.fn();
    const routes = createTimeZoneRoutes({ file, allowed: () => false, changed, env: {} });
    expect(await call(routes, "PUT", { timeZone: "Asia/Tokyo" })).toMatchObject({ status: 403 });
    expect(savedTimeZone(file)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
});
