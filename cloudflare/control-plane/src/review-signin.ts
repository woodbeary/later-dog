import { z } from "zod";

export interface ReviewSignIn {
  email: string;
  code: string;
}

const REVIEW_CODE = /^[0-9]{8}$/;
const reviewEmailSchema = z.email().max(254);

export function reviewSignIn(env: Partial<Record<"REVIEW_EMAIL" | "REVIEW_SIGNIN_CODE", unknown>>): ReviewSignIn | null {
  const email = typeof env.REVIEW_EMAIL === "string" ? env.REVIEW_EMAIL.trim().toLowerCase() : "";
  const code = typeof env.REVIEW_SIGNIN_CODE === "string" ? env.REVIEW_SIGNIN_CODE.trim() : "";
  if (!email || !REVIEW_CODE.test(code) || !reviewEmailSchema.safeParse(email).success) return null;
  return { email, code };
}

export function isReviewEmail(review: ReviewSignIn | null, email: string): review is ReviewSignIn {
  return review !== null && email.trim().toLowerCase() === review.email;
}
