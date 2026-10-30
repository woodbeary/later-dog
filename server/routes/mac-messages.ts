import type { ZodError } from "zod";
import {
  MAC_MESSAGES_WORDS, readTexts, readTextsInput, READ_TEXTS_PATH, sendEmail, sendEmailInput, SEND_EMAIL_PATH, sendText, sendTextInput, SEND_TEXT_PATH,
  type MessagesAnswer, type MessagesMac,
} from "../laterdog/mac-messages.ts";
import { MAC_NEVER } from "../mac-approval.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export interface MacMessagesRouteDeps {
  enabled(): boolean;
  active(capability: unknown): boolean;
  mac(capability: unknown, computerId: string | undefined): Promise<MessagesMac>;
}

function problems(error: ZodError): string {
  return `Check the request: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`;
}

const HANDLERS = {
  [SEND_TEXT_PATH]: { input: sendTextInput, run: sendText },
  [READ_TEXTS_PATH]: { input: readTextsInput, run: readTexts },
  [SEND_EMAIL_PATH]: { input: sendEmailInput, run: sendEmail },
} as const;

function failure(error: unknown): MessagesAnswer {
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502;
  return { status, body: { error: error instanceof Error ? error.message : "The Mac couldn't do it." } };
}

export function createMacMessagesRoute(deps: MacMessagesRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability }) => {
    if (method !== "POST" || !Object.hasOwn(HANDLERS, path) || !deps.enabled()) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const handler = HANDLERS[path as keyof typeof HANDLERS];
    const parsed = handler.input.safeParse(await readBody());
    if (!parsed.success) return json(res, 400, { error: `${path === READ_TEXTS_PATH ? "" : `${MAC_MESSAGES_WORDS.notSent} `}${problems(parsed.error)}` });
    const input = parsed.data;
    const answer = await deps.mac(capability, input.computer_id)
      .then((mac) => mac.never
        ? { status: 403, body: { error: MAC_NEVER } }
        : (handler.run as (value: typeof input, on: MessagesMac) => Promise<MessagesAnswer>)(input, mac))
      .catch(failure);
    return json(res, answer.status, answer.body);
  };
}
