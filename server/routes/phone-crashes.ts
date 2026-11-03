import { phoneCrashLine, phoneCrashReport, type PhoneCrashes } from "../laterdog/phone-crashes.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PHONE_CRASHES_PATH = "/api/phone/crashes";

export function createPhoneCrashRoutes(deps: { crashes: PhoneCrashes; log(line: string): void }): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== PHONE_CRASHES_PATH) return PASS;
    if (method === "GET") return json(res, 200, { reports: deps.crashes.recent() });
    if (method !== "POST") return json(res, 405, { error: "GET or POST only" });
    const parsed = phoneCrashReport.safeParse(await readBody(req, 64_000));
    if (!parsed.success) return json(res, 400, { error: "not a phone crash report" });
    deps.crashes.record(parsed.data);
    deps.log(phoneCrashLine(parsed.data));
    return json(res, 201, { ok: true });
  };
}
