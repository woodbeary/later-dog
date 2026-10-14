import { phonePushRequest, type PhonePush } from "../laterdog/phone-push.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PHONE_PUSH_PATH = "/api/phone/push";

export function createPhonePushRoutes(deps: { push: PhonePush }): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== PHONE_PUSH_PATH) return PASS;
    const answer = await phonePushRequest(method, () => readBody(req), deps.push);
    return json(res, answer.status, answer.body);
  };
}
