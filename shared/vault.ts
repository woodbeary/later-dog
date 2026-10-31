import { asksForDetails, isSharedHost, normalizeSecureHost, type SecureFieldDetail, type SecureFormField } from "./secure-form.ts";

export const VAULT_MAX_LOGINS = 500;
export const VAULT_VALUE_CHARS = 512;
export const VAULT_NOTE_CHARS = 500;
export const VAULT_IMPORT_BYTES = 2_000_000;
export const VAULT_ALLOW_PREFIX = "vault:";
export const VAULT_DETAIL_CHARS = 200;
export const VAULT_DETAIL_KEYS = [
  "name", "email", "tel", "organization", "address-line1", "address-line2", "address-level2", "address-level1", "postal-code", "country-name",
] as const;
export type VaultDetailKey = (typeof VAULT_DETAIL_KEYS)[number];
export type VaultDetails = Partial<Record<VaultDetailKey, string>>;

export interface VaultDetailsView {
  available: boolean;
  details: VaultDetails;
}

export interface VaultLogin {
  id: string;
  site: string;
  username: string;
  note?: string;
  updatedAt: number;
  usedAt?: number;
}

export type VaultUnavailable = "cloud-only" | "unreadable";

export interface VaultView {
  available: boolean;
  reason?: VaultUnavailable;
  logins: VaultLogin[];
}

export interface VaultOffers {
  available: boolean;
  logins: VaultLogin[];
  lookalike: string | null;
}

export interface VaultImportResult {
  added: number;
  updated: number;
  skipped: number;
  full: number;
}

export interface VaultFieldPlan {
  username?: string;
  password?: string;
}

export function vaultSite(raw: unknown): string | null {
  const host = normalizeSecureHost(raw);
  if (!host) return null;
  const labels = host.split(".");
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  const tail = labels.slice(-2).join(".");
  if (!isSharedHost(tail)) return tail;
  return labels.length > 2 ? labels.slice(-3).join(".") : null;
}

export function vaultAllowKey(site: string): string {
  return VAULT_ALLOW_PREFIX + site;
}

export function vaultAllowSite(key: string): string | null {
  return key.startsWith(VAULT_ALLOW_PREFIX) ? vaultSite(key.slice(VAULT_ALLOW_PREFIX.length)) : null;
}

export function detailValue(details: VaultDetails, wanted: SecureFieldDetail): string {
  const name = details.name?.trim() ?? "";
  const words = name.split(/\s+/).filter(Boolean);
  switch (wanted) {
    case "given-name": return words.length > 1 ? words.slice(0, -1).join(" ") : name;
    case "family-name": return words.length > 1 ? words[words.length - 1]! : "";
    case "street-address": return [details["address-line1"], details["address-line2"]].map((line) => line?.trim() ?? "").filter(Boolean).join(", ");
    default: return details[wanted]?.trim() ?? "";
  }
}

export function detailsFill(fields: readonly Pick<SecureFormField, "id" | "autocomplete">[], details: VaultDetails): Record<string, string> {
  return Object.fromEntries(fields.flatMap((field) => {
    const value = field.autocomplete ? detailValue(details, field.autocomplete) : "";
    return value ? [[field.id, value]] : [];
  }));
}

export function detailsFromForm(fields: readonly Pick<SecureFormField, "id" | "autocomplete">[], values: ReadonlyMap<string, string>): VaultDetails {
  const keys: readonly string[] = VAULT_DETAIL_KEYS;
  return Object.fromEntries(fields.flatMap((field) => {
    const value = values.get(field.id)?.trim();
    return field.autocomplete && keys.includes(field.autocomplete) && value ? [[field.autocomplete, value]] : [];
  }));
}

export function vaultFieldPlan(fields: readonly Pick<SecureFormField, "id" | "type" | "autocomplete">[]): VaultFieldPlan | null {
  if (asksForDetails(fields)) return null;
  const plan: VaultFieldPlan = {};
  for (const field of fields) {
    if (field.type === "password") {
      if (plan.password) return null;
      plan.password = field.id;
    } else if (field.type === "email" || field.type === "text") {
      if (plan.username) return null;
      plan.username = field.id;
    } else {
      return null;
    }
  }
  return plan.username || plan.password ? plan : null;
}

export function savesAsLogin(fields: readonly Pick<SecureFormField, "id" | "type" | "autocomplete">[]): boolean {
  const plan = vaultFieldPlan(fields);
  return Boolean(plan?.username && plan.password);
}
