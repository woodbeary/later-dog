export const SECURE_FIELD_TYPES = ["text", "email", "password", "code"] as const;
export type SecureFieldType = (typeof SECURE_FIELD_TYPES)[number];
export const SECURE_FIELD_DETAILS = [
  "name", "given-name", "family-name", "email", "tel", "organization",
  "street-address", "address-line1", "address-line2", "address-level2", "address-level1", "postal-code", "country-name",
] as const;
export type SecureFieldDetail = (typeof SECURE_FIELD_DETAILS)[number];
export const SECURE_FORM_MAX_FIELDS = 10;
export const SECURE_VALUE_CHARS = 512;
export const SECURE_FIELD_ID = /^[a-z][a-z0-9_]{0,31}$/;

export interface SecureFormField {
  id: string;
  label: string;
  type: SecureFieldType;
  autocomplete?: SecureFieldDetail;
  optional?: boolean;
  filled?: boolean;
}

export type SecureFormStatus = "open" | "sending" | "filled" | "expired" | "superseded";

export interface SecureFormCardData {
  title: string;
  host: string;
  fields: SecureFormField[];
  status: SecureFormStatus;
  until?: number;
  saved?: { username: string };
}

const SHARED_HOSTS = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com", "appspot.com",
  "web.app", "firebaseapp.com", "blogspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "glitch.me",
  "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "wixsite.com", "myshopify.com",
  "wordpress.com", "notion.site", "replit.app", "repl.co", "surge.sh", "r2.dev",
]);
const SHARED_SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|or|ne|go|gob|mil|nic|ltd|plc|sch)\.[a-z]{2}$/;

export function asksForDetails(fields: readonly Pick<SecureFormField, "autocomplete">[]): boolean {
  return fields.some((field) => field.autocomplete !== undefined && field.autocomplete !== "email");
}

export function secureFormReady(fields: readonly Pick<SecureFormField, "id" | "type" | "optional">[], values: Readonly<Record<string, string>>): boolean {
  return fields.every((field) => field.optional === true || (field.type === "password" ? values[field.id] ?? "" : (values[field.id] ?? "").trim()).length > 0);
}

export function isOpenSecureForm(status: SecureFormStatus): boolean {
  return status === "open" || status === "sending";
}

export function shownSecureFormStatus(card: Pick<SecureFormCardData, "status" | "until">, now: number): SecureFormStatus {
  return card.status === "sending" && card.until !== undefined && card.until <= now ? "expired" : card.status;
}

export function normalizeSecureHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 300) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (host.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
  return host.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) ? host : null;
}

export function isSharedHost(host: string): boolean {
  const bare = host.replace(/^www\./, "");
  return SHARED_HOSTS.has(bare) || SHARED_SECOND_LEVEL.test(bare);
}
