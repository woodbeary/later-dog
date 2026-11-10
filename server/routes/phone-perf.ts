import { phonePerformanceReport, type PhonePerformance } from "../laterdog/phone-perf.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createPhonePerformanceRoutes(reports: PhonePerformance): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/phone/perf") return PASS;
    if (method === "GET") return json(res, 200, { reports: reports.recent() });
    if (method !== "POST") return json(res, 405, { error: "GET or POST only" });
    const parsed = phonePerformanceReport.safeParse(await readBody(req, 64_000));
    if (!parsed.success) return json(res, 400, { error: "not a phone performance report" });
    reports.record(parsed.data);
    return json(res, 201, { ok: true });
  };
}
