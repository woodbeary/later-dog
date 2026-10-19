import { captcha } from "better-auth/plugins";

export const CAPTCHA_HEADER = "x-captcha-response";
const CAPTCHA_ENDPOINTS = ["/email-otp/send-verification-otp"];
const SITE_KEY = /^[0-9A-Za-z_-]{8,100}$/;
const CLOUDFLARE_TEST_SECRET = /^[1-3]x0{31}AA$/;

type TurnstileEnv = Partial<Record<"TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY", unknown>>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function turnstileSecret(env: Env): string | null {
  return text((env as unknown as TurnstileEnv).TURNSTILE_SECRET_KEY) || null;
}

export function turnstileSiteKey(env: Env): string | null {
  const key = text((env as unknown as TurnstileEnv).TURNSTILE_SITE_KEY);
  return SITE_KEY.test(key) ? key : null;
}

export function carriesCaptcha(request: Request): boolean {
  return Boolean(request.headers.get(CAPTCHA_HEADER)?.trim());
}

export function turnstileHostnames(secretKey: string, pageOrigin: string): string[] | undefined {
  return CLOUDFLARE_TEST_SECRET.test(secretKey) ? undefined : [new URL(pageOrigin).hostname];
}

export function captchaPlugins(env: Env, request: Request, pageOrigin: string) {
  const secretKey = turnstileSecret(env);
  if (!secretKey || !carriesCaptcha(request)) return [];
  return [captcha({
    provider: "cloudflare-turnstile",
    secretKey,
    endpoints: CAPTCHA_ENDPOINTS,
    allowedHostnames: turnstileHostnames(secretKey, pageOrigin),
  })];
}
