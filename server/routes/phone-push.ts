import { phonePushRequest, PHONE_PUSH_TEST_PATH, type PhonePush } from "../laterdog/phone-push.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PHONE_PUSH_PATH = "/api/phone/push";

export function createPhonePushRoutes(deps: { push: PhonePush }): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === PHONE_PUSH_TEST_PATH) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const report = await deps.push.test();
      return json(res, 200, { ok: report.accepted > 0 && report.errors.length === 0, ...report });
    }
    if (path !== PHONE_PUSH_PATH) return PASS;
    const answer = await phonePushRequest(method, () => readBody(req), deps.push, url);
    return json(res, answer.status, answer.body);
  };
}
