import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudHold, type HeldRoutines } from "./cloud-hold.ts";
import { createCloudHoldRoutes } from "./cloud-hold-http.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "../request-auth.ts";

const scratch: string[] = [];
const folder = () => { const path = mkdtempSync(join(tmpdir(), "laterdog-cloud-hold-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function routines(enabled: Record<string, boolean>): HeldRoutines & { enabled: Record<string, boolean> } {
  return {
    enabled,
    listRoutines: () => Object.entries(enabled).map(([id, on]) => ({ id, enabled: on })),
    update(id, patch) { enabled[id] = patch.enabled; return { id }; },
  };
}

describe("holding this computer's dogs while signed in to Cloud", () => {
  it("pauses every enabled routine and refuses new dog turns, then resumes only the routines it paused", () => {
    const hold = new CloudHold(join(folder(), "cloud-hold.json"));
    const all = routines({ nightly: true, weekly: true, manual: false });
    expect(() => hold.assertAvailable()).not.toThrow();
    expect(hold.hold(all)).toEqual({ held: true, paused: 2 });
    expect(all.enabled).toEqual({ nightly: false, weekly: false, manual: false });
    expect(() => hold.assertAvailable()).toThrowError(/working in My Cloud/);
    expect(hold.release(all)).toEqual({ held: false, resumed: 2 });
    expect(all.enabled).toEqual({ nightly: true, weekly: true, manual: false });
    expect(() => hold.assertAvailable()).not.toThrow();
  });

  it("does not turn back on a routine the person changed while it was held, and survives a restart", () => {
    const file = join(folder(), "cloud-hold.json");
    const all = routines({ nightly: true, weekly: true });
    new CloudHold(file).hold(all);
    const restarted = new CloudHold(file);
    expect(restarted.held).toBe(true);
    all.enabled.weekly = true;
    expect(restarted.release(all).resumed).toBe(1);
    expect(all.enabled).toEqual({ nightly: true, weekly: true });
    expect(new CloudHold(file).held).toBe(false);
  });

  it("answers the desktop over HTTP for the owner only", async () => {
    const hold = new CloudHold(join(folder(), "cloud-hold.json"));
    const all = routines({ nightly: true });
    const route = createCloudHoldRoutes({ hold, routines: () => all, readBody: async (req) => (req as unknown as { body: unknown }).body });
    const call = async (method: string, body: unknown, scopes = ["admin"]) => {
      const out: { status?: number; body?: unknown } = {};
      const res = { writeHead: (status: number) => { out.status = status; }, end: (text: string) => { out.body = JSON.parse(text); } } as unknown as ServerResponse;
      const handled = await route({ method, body } as unknown as IncomingMessage, res, "/api/cloud-hold", { scopes } as unknown as RequestAuth);
      return { handled, ...out };
    };
    expect(await call("POST", { held: true })).toMatchObject({ handled: true, status: 200, body: { held: true, paused: 1 } });
    expect(await call("GET", undefined)).toMatchObject({ status: 200, body: { held: true } });
    expect(await call("POST", { held: "yes" })).toMatchObject({ status: 400 });
    expect(await call("POST", { held: false }, ["client"])).toMatchObject({ status: 403 });
    expect(hold.held).toBe(true);
    expect(await call("POST", { held: false })).toMatchObject({ status: 200, body: { held: false, resumed: 1 } });
    expect(all.enabled.nightly).toBe(true);
  });
});
