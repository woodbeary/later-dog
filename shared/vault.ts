import { isSharedHost, normalizeSecureHost, type SecureFormField } from "./secure-form.ts";

export const VAULT_MAX_LOGINS = 500;
export const VAULT_VALUE_CHARS = 512;
export const VAULT_NOTE_CHARS = 500;
export const VAULT_IMPORT_BYTES = 2_000_000;
export const VAULT_ALLOW_PREFIX = "vault:";

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

export function vaultFieldPlan(fields: readonly Pick<SecureFormField, "id" | "type">[]): VaultFieldPlan | null {
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

export function savesAsLogin(fields: readonly Pick<SecureFormField, "id" | "type">[]): boolean {
  const plan = vaultFieldPlan(fields);
  return Boolean(plan?.username && plan.password);
}
