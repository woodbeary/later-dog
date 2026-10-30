import type { SecureForms } from "../laterdog/secure-form.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const SECURE_FORM_BODY_BYTES = 16_384;

export interface SecureFormRouteDeps {
  forms: Pick<SecureForms, "submit" | "useSaved">;
}

export function createSecureFormRoutes(deps: SecureFormRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/secure-forms\/([\w-]+)\/submit$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req, SECURE_FORM_BODY_BYTES);
    const threadId = String(body?.threadId ?? "");
    const submitted = typeof body?.login === "string"
      ? deps.forms.useSaved(m[1]!, threadId, m[2]!, { login: body.login, always: body.always === true })
      : deps.forms.submit(m[1]!, threadId, m[2]!, body?.values, { save: body?.save === true });
    if (!submitted.ok) return json(res, submitted.status, { error: submitted.error });
    return json(res, 200, { card: submitted.card, ...(submitted.saved === undefined ? {} : { saved: submitted.saved }) });
  };
}
