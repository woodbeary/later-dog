import type { HomesService } from "./cloud";

export const SEND_OTP_PATH = "/api/auth/email-otp/send-verification-otp";

export async function emailFromCodeRequest(request: Request): Promise<string | null> {
  const body = (await request.clone().json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  return email.includes("@") && email.length <= 320 ? email : null;
}

export async function warmHomeForEmail(env: Env, homes: Pick<HomesService, "open">, email: string): Promise<boolean> {
  const owner = await env.DB.prepare(
    `SELECT u.id AS id FROM "user" u JOIN cloud_homes h ON h.account_id = u.id WHERE lower(u.email) = ?`,
  ).bind(email).first<{ id: string }>();
  if (!owner) return false;
  await homes.open(owner.id);
  return true;
}
