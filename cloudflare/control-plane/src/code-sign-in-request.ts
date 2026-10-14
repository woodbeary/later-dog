import { SEND_OTP_PATH } from "./warm-home";

export const SIGN_IN_OTP_PATH = "/api/auth/sign-in/email-otp";

const CODE_SIGN_IN_PATHS = new Set([SEND_OTP_PATH, SIGN_IN_OTP_PATH]);

export function withoutAmbientCookie(request: Request, pathname: string): Request {
  if (request.method !== "POST" || !CODE_SIGN_IN_PATHS.has(pathname) || !request.headers.has("cookie")) return request;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
}
