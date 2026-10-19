import type { HomesService } from "./cloud";

export const SEND_OTP_PATH = "/api/auth/email-otp/send-verification-otp";

export async function accountFromSignIn(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const body = (await response.clone().json().catch(() => null)) as { user?: { id?: unknown } } | null;
  const id = body?.user?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

export async function warmHomeForAccount(env: Env, homes: Pick<HomesService, "open">, accountId: string): Promise<boolean> {
  const home = await env.DB.prepare("SELECT account_id FROM cloud_homes WHERE account_id = ? AND released_at IS NULL").bind(accountId).first();
  if (!home) return false;
  await homes.open(accountId);
  return true;
}
