import type { ServerResponse } from "node:http";
import type { ZodError } from "zod";
import { addJob, phoneAdd, phoneRead, phoneRegistration, phoneResult, readJob, type PhoneDesk, type PhoneJob, type PhoneOwner } from "../laterdog/phone-desk.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PHONE_DEVICE_PATH = "/api/phone/device";
export const PHONE_READ_PATH = "/api/internal/phone/read";
export const PHONE_ADD_PATH = "/api/internal/phone/add";
export const PHONE_SECRET_HEADER = "x-laterdog-phone-secret";

const DEVICE_ROUTE = /^\/api\/phone\/device\/([\w-]+)\/(poll|result|disconnect)$/;

export interface PhoneDeviceRouteDeps {
  desk: PhoneDesk;
  enabled(): boolean;
  owner(auth: RequestAuth): PhoneOwner | { error: string; status: number };
  gone(res: ServerResponse): AbortSignal;
}

export function isPhoneDevicePath(path: string): boolean {
  return path === PHONE_DEVICE_PATH || path.startsWith(`${PHONE_DEVICE_PATH}/`);
}

const statusOf = (error: unknown) => typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createPhoneDeviceRoutes(deps: PhoneDeviceRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!isPhoneDevicePath(path) || !deps.enabled()) return PASS;
    const owner = deps.owner(auth);
    if ("error" in owner) return json(res, owner.status, { error: owner.error });
    if (method === "GET" && path === PHONE_DEVICE_PATH) return json(res, 200, { phones: deps.desk.status(owner.person) });
    if (method !== "POST") return json(res, 405, { error: "POST only" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const secret = String(req.headers[PHONE_SECRET_HEADER] ?? "");
    const body = await readBody(req, 400_000);
    try {
      if (path === `${PHONE_DEVICE_PATH}/connect`) {
        const parsed = phoneRegistration.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Invalid phone registration" });
        deps.desk.connect(parsed.data, owner, secret);
        return json(res, 200, { ok: true });
      }
      const route = DEVICE_ROUTE.exec(path);
      if (!route) return json(res, 404, { error: "not found" });
      const [, id, action] = route;
      if (action === "poll") return json(res, 200, { job: await deps.desk.poll(id!, owner.session, secret, deps.gone(res)) });
      if (action === "result") {
        const parsed = phoneResult.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Invalid phone result" });
        deps.desk.complete(id!, owner.session, secret, parsed.data);
        return json(res, 200, { ok: true });
      }
      deps.desk.disconnect(id!, owner.session, secret);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, statusOf(error), { error: messageOf(error) });
    }
  };
}

function problems(error: ZodError): string {
  return `Check the request: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`;
}

function toJob(path: string, body: unknown): PhoneJob | { error: string } {
  if (path === PHONE_READ_PATH) {
    const parsed = phoneRead.safeParse(body);
    return parsed.success ? readJob(parsed.data) : { error: problems(parsed.error) };
  }
  const parsed = phoneAdd.safeParse(body);
  return parsed.success ? addJob(parsed.data) : { error: problems(parsed.error) };
}

export interface PhoneToolRouteDeps {
  enabled(): boolean;
  active(capability: unknown): boolean;
  request(job: PhoneJob, capability: unknown, sender: BotRecord): Promise<unknown>;
}

export function createPhoneToolRoute(deps: PhoneToolRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender }) => {
    if (method !== "POST" || (path !== PHONE_READ_PATH && path !== PHONE_ADD_PATH) || !deps.enabled()) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const job = toJob(path, await readBody());
    if ("error" in job) return json(res, 400, { error: job.error });
    try {
      return json(res, 200, { result: await deps.request(job, capability, sender) });
    } catch (error) {
      return json(res, statusOf(error), { error: messageOf(error) });
    }
  };
}
