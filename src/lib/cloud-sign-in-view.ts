import type { CloudSignInFailure } from "../../electron/cloud-sign-in.mjs";
import type { LocaleKey } from "@/locales";
import type { CloudCard } from "@/lib/cloud-account-view";

export const SIGN_IN_CODE_LENGTH = 8;
export const SIGN_IN_RESEND_SECONDS = 30;
export const TERMS_URL = "https://accounts.later.dog/terms";
export const PRIVACY_URL = "https://accounts.later.dog/privacy";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignInStep = "email" | "code";

export const validEmail = (value: string): boolean => EMAIL.test(value.trim());

export const codeDigits = (value: string): string => value.replace(/\D/g, "").slice(0, SIGN_IN_CODE_LENGTH);

export const codeComplete = (digits: string): boolean => digits.length === SIGN_IN_CODE_LENGTH;

const PROBLEMS: Record<CloudSignInFailure, LocaleKey> = {
  invalid_email: "cloudSignIn.problem.email",
  wrong_code: "cloudSignIn.problem.wrongCode",
  expired_code: "cloudSignIn.problem.expiredCode",
  rate_limited: "cloudSignIn.problem.rateLimited",
  email_unavailable: "cloudSignIn.problem.emailUnavailable",
  network: "cloudSignIn.problem.network",
  unavailable: "cloudSignIn.problem.other",
};

export const signInProblem = (code: CloudSignInFailure): LocaleKey => PROBLEMS[code] ?? PROBLEMS.unavailable;

export type GateLine =
  | { kind: "opening" }
  | { kind: "setting-up"; slow: boolean }
  | { kind: "stuck"; note: LocaleKey };

export function gateLine(card: CloudCard): GateLine | null {
  if (card.kind !== "signed-in") return null;
  const home = card.home;
  if (home?.status === "ready") return { kind: "opening" };
  if (!home) return { kind: "stuck", note: "cloudAccount.plan.full" };
  if (home.status === "provisioning") return { kind: "setting-up", slow: home.setup?.slow === true };
  if (home.status === "payment-problem") return { kind: "stuck", note: "cloudAccount.home.paymentProblem" };
  if (home.status === "stopped") return { kind: "stuck", note: "cloudAccount.home.stopped" };
  return { kind: "stuck", note: "cloudAccount.home.failed" };
}

export type OfferStatus = "checking" | "due" | "done";

export function offerStatus(input: { bridge: boolean; asked: boolean | null; card: CloudCard["kind"] | null; failed: boolean }): OfferStatus {
  if (!input.bridge || input.failed) return "done";
  if (input.asked === null || input.card === null || input.card === "loading") return "checking";
  return input.asked && input.card === "signed-out" ? "due" : "done";
}
