import { WorkerEntrypoint } from "cloudflare:workers";

import { readConfig } from "./config";
import { noteEmailFailure } from "./email-health";

export const OWNER_EMAILS_PER_DAY = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OwnerEmail {
  subject: string;
  text: string;
  attachments: Array<{ filename: string; type: string; content: string }>;
}

export type OwnerEmailResult = { ok: true } | { ok: false; status: number; error: string };

export interface OwnerEmailSender {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    attachments?: Array<{ filename: string; type: string; content: string; disposition: "attachment" }>;
  }): Promise<unknown>;
}

export async function sendOwnerEmail(
  env: Env,
  accountId: string,
  email: OwnerEmail,
  sender: OwnerEmailSender = env.EMAIL as unknown as OwnerEmailSender,
  now = Date.now(),
): Promise<OwnerEmailResult> {
  const user = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(accountId).first<{ email: string }>();
  if (!user) return { ok: false, status: 404, error: "This home has no account anymore." };
  const counted = await env.DB.prepare(
    `INSERT INTO cloud_owner_emails (account_id, day, sent) VALUES (?, ?, 1)
     ON CONFLICT(account_id, day) DO UPDATE SET sent = sent + 1 WHERE sent < ?`,
  ).bind(accountId, Math.floor(now / DAY_MS), OWNER_EMAILS_PER_DAY).run();
  if (counted.meta.changes === 0) {
    return { ok: false, status: 429, error: "You've had today's emails from your dogs. They come back tomorrow." };
  }
  const config = readConfig(env);
  try {
    await sender.send({
      to: user.email,
      from: { email: config.emailFrom, name: "later.dog" },
      subject: email.subject,
      text: email.text,
      ...(email.attachments.length
        ? { attachments: email.attachments.map(({ filename, type, content }) => ({ filename, type, content, disposition: "attachment" as const })) }
        : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "owner email failed", errorCode: "email_failed" }));
    const limit = await noteEmailFailure(env.DB, error, now).catch(() => null);
    if (limit === "E_DAILY_LIMIT_EXCEEDED") return { ok: false, status: 429, error: "later.dog has sent all the email it can today. Try again tomorrow." };
    return { ok: false, status: 502, error: "The email service didn't take it. Try again in a minute." };
  }
  return { ok: true };
}

export class AccountsApi extends WorkerEntrypoint<Env> {
  async sendOwnerEmail(accountId: string, email: OwnerEmail): Promise<OwnerEmailResult> {
    return sendOwnerEmail(this.env, accountId, email);
  }
}
