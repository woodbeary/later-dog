import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { currentGrokLogin } from "./guest-grok-login.ts";
import { userHome } from "../env-path.ts";
import { antigravityProfileDirectory } from "../drivers/antigravity-acp.ts";

export type GuestCliCredentials = { environment: Record<string, string>; files: Record<string, string> };

async function accountJson(file: string): Promise<Record<string, unknown> | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("The selected engine account file is invalid.");
    const data: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The selected engine account file is invalid.");
    return data as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The selected engine account file could not be read safely.");
  } finally { await handle?.close(); }
}

const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());

function fresh(value: unknown, now: number): boolean {
  if (value === undefined) return true;
  const expiry = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(expiry) && expiry > now;
}

function selected(record: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter(key => typeof record[key] === "string" || typeof record[key] === "number" || typeof record[key] === "boolean").map(key => [key, record[key]]));
}

export async function guestCliCredentials(driver: string, instanceId: string, environment: Record<string, string>, now = Date.now(), refreshCli?: string): Promise<GuestCliCredentials> {
  const home = userHome(environment);
  const out: GuestCliCredentials = { environment: {}, files: {} };
  const scoped = (keys: string[]) => {
    for (const key of keys) if (text(environment[key])) { out.environment[key] = environment[key]!; return true; }
    return false;
  };
  if (driver === "grokAgent") {
    const path = join(environment.GROK_HOME || join(home, ".grok"), "auth.json");
    let file: Record<string, unknown> | null;
    try { file = JSON.parse(await currentGrokLogin(path, refreshCli, now)) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The selected Grok login could not be read safely.");
      file = null;
    }
    const entries = Object.entries(file ?? {}).flatMap(([issuer, value]) => {
      if (!/^https:\/\/(?:auth\.x\.ai(?:::[a-zA-Z0-9-]+)?|accounts\.x\.ai\/sign-in)$/.test(issuer) || !value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      if (!text(record.key) || !fresh(record.expires_at, now)) return [];
      return [[issuer, selected(record, ["key", "auth_mode", "expires_at", "user_id", "principal_id", "principal_type", "team_id", "oidc_issuer", "oidc_client_id", "coding_data_retention_opt_out"])]];
    });
    if (entries.length !== 1) throw new Error("Grok needs one current sign-in for the selected account.");
    out.files.grok = JSON.stringify(Object.fromEntries(entries));
  } else if (driver === "cursorAgent") {
    if (scoped(["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"])) return out;
    const config = environment.XDG_CONFIG_HOME || join(home, ".config");
    const login = await accountJson(process.platform === "darwin" ? join(home, ".cursor", "auth.json") : join(config, "cursor", "auth.json"));
    if (text(login?.apiKey)) out.environment.CURSOR_API_KEY = login.apiKey;
    else if (text(login?.accessToken)) out.environment.CURSOR_AUTH_TOKEN = login.accessToken;
    else throw new Error("Cursor needs a transferable sign-in or API key for the selected account.");
  } else if (driver === "geminiAgent") {
    if (scoped(["GEMINI_API_KEY", "GOOGLE_API_KEY"])) return out;
    const login = await accountJson(join(home, ".gemini", "oauth_creds.json"));
    if (!login || !text(login.access_token) || !fresh(login.expiry_date, now)) throw new Error("Gemini needs a current sign-in or API key for the selected account.");
    out.files.gemini = JSON.stringify(selected(login, ["access_token", "token_type", "scope", "expiry_date", "id_token"]));
  } else if (driver === "droidAgent") {
    if (!scoped(["FACTORY_API_KEY"])) throw new Error("Droid needs the selected account's API key on its computer.");
  } else if (driver === "antigravityAgent") {
    const login = await accountJson(join(antigravityProfileDirectory(instanceId), "antigravity-acp", "acp_token.json"));
    if (!login) throw new Error("Antigravity needs a sign-in for the selected account.");
    const nested = login.token && typeof login.token === "object" && !Array.isArray(login.token) ? login.token as Record<string, unknown> : null;
    if (nested) {
      if (!text(nested.access_token) || !fresh(nested.expiry, now)) throw new Error("Antigravity needs a current access token for the selected account.");
      out.files.antigravity = JSON.stringify({ ...selected(login, ["auth_method", "id_token_email"]), token: selected(nested, ["access_token", "token_type", "expiry", "expires_in"]) });
    } else {
      const key = ["access_token", "accessToken", "token"].find(key => text(login[key]));
      if (!key || !fresh(login.expiry_date ?? login.expires_at ?? login.expiresAt, now)) throw new Error("Antigravity needs a current access token for the selected account.");
      out.files.antigravity = JSON.stringify(selected(login, [key, "expiry_date", "expires_at", "expiresAt", "token_type", "scope"]));
    }
  }
  return out;
}
