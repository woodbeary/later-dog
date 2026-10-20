import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";

import type { ControlPlaneConfig } from "./config";
import { sendOTPEmail } from "./email";
import { noteEmailFailure } from "./email-health";
import { alertOwner, emailServiceCode, ownerAlerts } from "./owner-alerts";
import { isReviewEmail, reviewSignIn } from "./review-signin";
import { captchaPlugins } from "./turnstile";

export function createAuth(
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
  request: Request | null = null,
) {
  const review = reviewSignIn(env as unknown as Partial<Record<"REVIEW_EMAIL" | "REVIEW_SIGNIN_CODE", unknown>>);
  return betterAuth({
    appName: "later.dog",
    baseURL: config.authBaseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [...config.allowedOrigins],
    logger: { disabled: true },
    verification: { disableCleanup: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: true,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      database: { generateId: "uuid" },
      backgroundTasks: {
        handler(promise) {
          ctx.waitUntil(promise);
        },
      },
    },
    plugins: [
      ...(request ? captchaPlugins(env, request, config.authBaseURL) : []),
      emailOTP({
        otpLength: 8,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: false,
        rateLimit: { window: 60, max: 5 },
        generateOTP: ({ email }) => (isReviewEmail(review, email) ? review.code : undefined),
        async sendVerificationOTP(input) {
          if (isReviewEmail(review, input.email)) return;
          await sendOTPEmail({
            async send(message) {
              await env.EMAIL.send(message);
            },
          }, config.emailFrom, input, requestId, (error) => Promise.all([
            noteEmailFailure(env.DB, error),
            alertOwner(env, ownerAlerts.codeEmailFailed(emailServiceCode(error))),
          ]));
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export type ControlPlaneAuth = ReturnType<typeof createAuth>;

export async function deleteExpiredVerifications(auth: ControlPlaneAuth): Promise<void> {
  const context = await auth.$context;
  await context.adapter.deleteMany({
    model: "verification",
    where: [{ field: "expiresAt", operator: "lt", value: new Date() }],
  });
}

export async function accountSession(request: Request, auth: ControlPlaneAuth) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].startsWith("laterdog_install_")) return null;

  return auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${match[1]}` }),
  });
}
