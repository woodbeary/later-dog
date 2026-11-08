import { generateSecret, secretNameProblem, vaultFingerprint, VAULT_CHARSETS, type VaultCharset } from "../laterdog/vault-refs.ts";
import { VAULT_OWNER_ONLY } from "../laterdog/vault-commands.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const VAULT_SECRET_PATH = "/api/internal/vault-secret";

export interface VaultSecretRouteDeps {
  active(capability: unknown): boolean;
  ownerActing(threadId: string): boolean;
  by(senderId: string): string;
  list(): { name: string; createdBy?: string; updatedAt: number }[];
  save(name: string, value: string, by: string): { replaced: boolean };
}

export function createVaultSecretRoute(deps: VaultSecretRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender, threadId }) => {
    if (path !== VAULT_SECRET_PATH || method !== "POST") return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    if (!deps.ownerActing(threadId)) return json(res, 403, { error: VAULT_OWNER_ONLY });
    const body = await readBody();
    if (body?.action === "list") {
      const items = deps.list();
      return json(res, 200, { text: items.length
        ? items.map((item) => `${item.name}${item.createdBy ? ` (made by ${item.createdBy})` : ""}, changed ${new Date(item.updatedAt).toISOString().slice(0, 10)}`).join("\n")
        : "No vault items yet. Make one with action generate." });
    }
    if (body?.action !== "generate") return json(res, 400, { error: "vault_secret takes action generate or list." });
    const problem = secretNameProblem(body.name);
    if (problem) return json(res, 400, { error: problem });
    const length = body.length === undefined ? 40 : Number(body.length);
    if (!Number.isInteger(length) || length < 16 || length > 256) return json(res, 400, { error: "length is 16 to 256 characters." });
    const charset = (body.charset ?? "alnum") as VaultCharset;
    if (!VAULT_CHARSETS.includes(charset)) return json(res, 400, { error: `charset is one of ${VAULT_CHARSETS.join(", ")}.` });
    const value = generateSecret(length, charset);
    try {
      const saved = deps.save(body.name as string, value, deps.by(sender.id));
      return json(res, 200, { text: JSON.stringify({ name: body.name, fingerprint: vaultFingerprint(value), length, charset, replaced: saved.replaced }) });
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
