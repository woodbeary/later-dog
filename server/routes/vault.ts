import { VAULT_IMPORT_BYTES } from "../../shared/vault.ts";
import { importedLogins } from "../laterdog/vault-import.ts";
import { VaultInputError, type LoginInput, type VaultStore } from "../laterdog/vault.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const VAULT_LOGIN_BODY_BYTES = 16_384;
const LOGIN_PATH = /^\/api\/vault\/logins\/([\w-]{1,64})$/;
const GONE = "That login is no longer in your vault.";

function loginFields(body: unknown): Partial<LoginInput> {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return Object.fromEntries((["site", "username", "password", "note"] as const).filter((key) => key in record).map((key) => [key, record[key]]));
}

export function createVaultRoutes(deps: { vault: Pick<VaultStore, "view" | "offers" | "save" | "update" | "remove" | "importLogins" | "details" | "saveDetails"> }): RouteHandler {
  const { vault } = deps;
  return async ({ req, res, method, path, url, json, readBody }) => {
    if (path !== "/api/vault" && !path.startsWith("/api/vault/")) return PASS;
    const login = LOGIN_PATH.exec(path);
    try {
      if (path === "/api/vault" && method === "GET") return json(res, 200, vault.view());
      if (path === "/api/vault/offers" && method === "GET") return json(res, 200, vault.offers(url.searchParams.get("host") ?? ""));
      if (path === "/api/vault/details" && method === "GET") return json(res, 200, vault.details());
      if (path === "/api/vault/details" && method === "PUT") {
        const body = await readBody(req, VAULT_LOGIN_BODY_BYTES);
        return json(res, 200, { details: vault.saveDetails(body?.details) });
      }
      if (path === "/api/vault/logins" && method === "POST") {
        const body = loginFields(await readBody(req, VAULT_LOGIN_BODY_BYTES));
        return json(res, 200, vault.save({ site: body.site, username: body.username, password: body.password, note: body.note }));
      }
      if (login && method === "PATCH") {
        const updated = vault.update(login[1]!, loginFields(await readBody(req, VAULT_LOGIN_BODY_BYTES)));
        return updated ? json(res, 200, { login: updated }) : json(res, 404, { error: GONE });
      }
      if (login && method === "DELETE") return vault.remove(login[1]!) ? json(res, 200, { ok: true }) : json(res, 404, { error: GONE });
      if (path === "/api/vault/import" && method === "POST") {
        const body = await readBody(req, VAULT_IMPORT_BYTES + 1_024);
        const parsed = importedLogins(typeof body?.csv === "string" ? body.csv : "");
        if ("error" in parsed) return json(res, 400, { error: parsed.error });
        return json(res, 200, vault.importLogins(parsed.logins, parsed.skipped));
      }
    } catch (error) {
      if (error instanceof VaultInputError) return json(res, 400, { error: error.message });
      throw error;
    }
    return json(res, 405, { error: "Unsupported vault request." });
  };
}
