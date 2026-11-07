import type { VaultLogin } from "../../shared/vault.ts";
import type { SavedCredentials } from "./vault.ts";

export interface VaultSource {
  list(): VaultLogin[];
  matching(host: string): VaultLogin[];
  credentials(id: string): SavedCredentials | null;
}

export type VaultInput = { ok: true; input: string; secret: string; username: string } | { ok: false; error: string };

export function vaultInput(vault: VaultSource, asked: string): VaultInput {
  const want = asked.trim();
  if (!want) return { ok: false, error: "vault_login needs the saved login's id or site." };
  const at = want.lastIndexOf("@");
  const byId = vault.list().filter((login) => login.id === want);
  const whole = byId.length ? byId : vault.matching(want);
  const site = whole.length || at <= 0 ? want : want.slice(at + 1);
  const username = whole.length || at <= 0 ? undefined : want.slice(0, at);
  const bySite = whole.length ? whole : vault.matching(site).filter((login) => !username || login.username === username);
  if (bySite.length !== 1) {
    const sites = [...new Set(vault.list().map((login) => login.site))].join(", ") || "none saved yet";
    return { ok: false, error: bySite.length
      ? `More than one login is saved for ${site}; name it as username@${site}.`
      : `No saved login for "${want}". Saved sites: ${sites}. Ask the person to save it in the vault (Settings → Vault) first.` };
  }
  const login = vault.credentials(bySite[0]!.id);
  if (!login?.password) return { ok: false, error: "That saved login has no password." };
  return { ok: true, input: `${login.password}\n`, secret: login.password, username: login.username };
}

export function withoutSecret<T>(value: T, secret: string): T {
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("••••") as T;
  if (Array.isArray(value)) return value.map((item) => withoutSecret(item, secret)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutSecret(item, secret)])) as T;
  }
  return value;
}
