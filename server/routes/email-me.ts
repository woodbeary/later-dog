import { emailMe, type MacRead, type OutgoingEmail } from "../laterdog/email-me.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const EMAIL_ME_PATH = "/api/internal/email-me";

export interface EmailMeRouteDeps {
  deliver: ((email: OutgoingEmail) => Promise<void>) | null;
  active(capability: unknown): boolean;
  readMacFile(operation: MacRead, capability: unknown): Promise<unknown>;
}

export function createEmailMeRoute(deps: EmailMeRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, readBody, capability }) => {
    if (method !== "POST" || path !== EMAIL_ME_PATH || !deps.deliver) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const deliver = deps.deliver;
    const answer = await emailMe(await readBody(), {
      botName: sender.name,
      readMacFile: (operation) => deps.readMacFile(operation, capability),
      deliver,
    }).catch((error: unknown) => ({
      status: typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502,
      body: { error: error instanceof Error ? error.message : "The email could not be sent." },
    }));
    return json(res, answer.status, answer.body);
  };
}
