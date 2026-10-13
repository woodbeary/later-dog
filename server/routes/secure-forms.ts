import type { SecureForms } from "../laterdog/secure-form.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const SECURE_FORM_BODY_BYTES = 16_384;

export interface SecureFormRouteDeps {
  forms: Pick<SecureForms, "submit">;
}

export function createSecureFormRoutes(deps: SecureFormRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/secure-forms\/([\w-]+)\/submit$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req, SECURE_FORM_BODY_BYTES);
    const submitted = deps.forms.submit(m[1]!, String(body?.threadId ?? ""), m[2]!, body?.values);
    return submitted.ok ? json(res, 200, { card: submitted.card }) : json(res, submitted.status, { error: submitted.error });
  };
}
