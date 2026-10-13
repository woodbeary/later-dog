import { readConfig } from "./config";
import { emailBlocked, noteEmailFailure } from "./email-health";

export const INVITE_HOLD_MS = 48 * 60 * 60_000;
export const INVITE_BATCH = 50;

export interface InviteSender {
  send(message: { to: string; from: { email: string; name: string }; subject: string; text: string }): Promise<unknown>;
}

export const INVITE_SUBJECT = "There's room for you on later.dog Cloud";
export const INVITE_TEXT = "Good news: there's a home for your dogs on later.dog Cloud now.\n\nOpen later.dog on your iPhone or Mac and sign in with this email. We'll hold your spot for 2 days.\n\nlater.dog";

export async function joinWaitlist(env: Env, accountId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_waitlist (account_id, created_at) VALUES (?, ?)").bind(accountId, now).run();
}

export async function inviteFromWaitlist(env: Env, cap: number, sender: InviteSender = env.EMAIL as unknown as InviteSender, now = Date.now()): Promise<number> {
  if (await emailBlocked(env.DB, now)) return 0;
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM cloud_homes) AS homes,
            (SELECT COUNT(*) FROM cloud_waitlist w WHERE w.invited_at > ? AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.account_id = w.account_id)) AS held`,
  ).bind(now - INVITE_HOLD_MS).first<{ homes: number; held: number }>();
  const room = cap - (counts?.homes ?? 0) - (counts?.held ?? 0);
  if (room <= 0) return 0;
  const waiting = await env.DB.prepare(
    `SELECT w.account_id AS accountId, u.email AS email FROM cloud_waitlist w JOIN "user" u ON u.id = w.account_id
      WHERE w.invited_at IS NULL AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.account_id = w.account_id)
      ORDER BY w.created_at LIMIT ?`,
  ).bind(Math.min(room, INVITE_BATCH)).all<{ accountId: string; email: string }>();
  const from = readConfig(env).emailFrom;
  let invited = 0;
  for (const person of waiting.results) {
    try {
      await sender.send({ to: person.email, from: { email: from, name: "later.dog" }, subject: INVITE_SUBJECT, text: INVITE_TEXT });
    } catch (error) {
      await noteEmailFailure(env.DB, error, now).catch(() => null);
      break;
    }
    await env.DB.prepare("UPDATE cloud_waitlist SET invited_at = ? WHERE account_id = ?").bind(now, person.accountId).run();
    invited += 1;
  }
  return invited;
}
