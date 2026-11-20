import { asksForDetails, type SecureFormCardData, type SecureFormField } from "../../shared/secure-form";
import { vaultAccount, vaultFieldPlan, type VaultLogin } from "../../shared/vault";

export type SignInPhase = "pick" | "type";

export function firstPhase(card: Pick<SecureFormCardData, "tried">, logins: readonly VaultLogin[]): SignInPhase {
  return card.tried?.rejected || logins.length === 0 ? "type" : "pick";
}

export function keptValues(card: Pick<SecureFormCardData, "fields" | "tried">): Record<string, string> {
  const username = card.tried?.username;
  const plan = vaultFieldPlan(card.fields);
  return username && plan?.username ? { [plan.username]: username } : {};
}

export function saveAtFirst(card: Pick<SecureFormCardData, "fields" | "tried">): boolean {
  if (asksForDetails(card.fields)) return false;
  return card.tried ? card.tried.save === true || card.tried.login !== undefined : true;
}

export function savesOverAccount(card: Pick<SecureFormCardData, "fields">, logins: readonly VaultLogin[], values: Readonly<Record<string, string>>): boolean {
  const plan = vaultFieldPlan(card.fields);
  const typed = plan?.username ? (values[plan.username] ?? "").trim() : "";
  return typed !== "" && logins.some((login) => vaultAccount(login.site, login.username) === vaultAccount(login.site, typed));
}

export function asksForPassword(fields: readonly Pick<SecureFormField, "type" | "autocomplete">[]): boolean {
  return !asksForDetails(fields) && fields.some((field) => field.type === "password");
}

export function firstEmpty(fields: readonly Pick<SecureFormField, "id" | "type" | "optional">[], values: Readonly<Record<string, string>>): number {
  const index = fields.findIndex((field) => !field.optional && !(field.type === "password" ? values[field.id] ?? "" : (values[field.id] ?? "").trim()));
  return index < 0 ? 0 : index;
}

export function monogram(username: string): string {
  const first = [...username.trim()][0] ?? "";
  return /\p{L}|\p{N}/u.test(first) ? first.toUpperCase() : "•";
}
