import { createHash, randomInt } from "node:crypto";

export const VAULT_SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
export const VAULT_SECRET_MAX = 4096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const CHARSETS = {
  alnum: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  hex: "0123456789abcdef",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  symbols: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+,-.:=@^_~",
} as const;
export type VaultCharset = keyof typeof CHARSETS;
export const VAULT_CHARSETS = Object.keys(CHARSETS) as VaultCharset[];

export const VAULT_USES_SCHEMA = {
  type: "array", maxItems: 8,
  description: "Vault items to hand the command by name; the home puts the value in at run time and masks any copy in the output. as stdin: the command's stdin; as env: an environment variable named env; as file: written to path with mode 600.",
  items: { type: "object", additionalProperties: false, required: ["name", "as"], properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    as: { type: "string", enum: ["stdin", "env", "file"] },
    env: { type: "string", maxLength: 64 },
    path: { type: "string", maxLength: 1024 },
  } },
};
export const VAULT_CAPTURE_SCHEMA = {
  type: "string", minLength: 1, maxLength: 120,
  description: "Save the command's stdout as this vault item instead of showing it; you get back its name and a fingerprint.",
};

export type VaultUse = { name: string; as: "stdin" | "env" | "file"; env?: string; path?: string };
export type ResolvedUse = VaultUse & { value: string };

export function vaultFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function generateSecret(length = 40, charset: VaultCharset = "alnum"): string {
  const alphabet = CHARSETS[charset];
  let out = "";
  for (let index = 0; index < length; index += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function secretNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !VAULT_SECRET_NAME.test(name)) {
    return "Name the vault item with letters, digits, dots, dashes, underscores and slashes, for example ocjr/OPERATOR_DASHBOARD_TOKEN.";
  }
  return null;
}

export function parseVaultUses(raw: unknown): { ok: true; uses: VaultUse[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, uses: [] };
  if (!Array.isArray(raw) || raw.length > 8) return { ok: false, error: "vault takes a list of up to 8 items: { name, as: stdin | env | file, env, path }." };
  const uses: VaultUse[] = [];
  for (const item of raw) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const problem = secretNameProblem(entry.name);
    if (problem) return { ok: false, error: problem };
    const as = entry.as;
    if (as !== "stdin" && as !== "env" && as !== "file") return { ok: false, error: `Say how ${String(entry.name)} reaches the command: as stdin, env or file.` };
    if (as === "env" && (typeof entry.env !== "string" || !ENV_NAME.test(entry.env))) return { ok: false, error: `Give ${String(entry.name)} an env name, such as TOKEN.` };
    if (as === "file" && (typeof entry.path !== "string" || !entry.path.trim() || entry.path.length > 1024 || /[\n\0]/.test(entry.path))) {
      return { ok: false, error: `Give ${String(entry.name)} a file path.` };
    }
    uses.push({ name: entry.name as string, as, ...(as === "env" ? { env: entry.env as string } : {}), ...(as === "file" ? { path: (entry.path as string).trim() } : {}) });
  }
  if (uses.filter((use) => use.as === "stdin").length > 1) return { ok: false, error: "Only one vault item can be the command's stdin." };
  return { ok: true, uses };
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const decoded = (value: string) => `printf %s ${quote(Buffer.from(value, "utf8").toString("base64"))} | base64 --decode`;
const shellPath = (path: string) => path === "~" ? '"$HOME"' : path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path);

export function wrapVaultCommand(command: string, uses: readonly ResolvedUse[], captureTo?: string): string {
  if (!uses.length && captureTo === undefined) return command;
  const lines: string[] = [];
  for (const use of uses) {
    if (use.as === "env") lines.push(`export ${use.env}="$(${decoded(use.value)})"`);
    if (use.as === "file") lines.push(`( umask 077; ${decoded(use.value)} > ${shellPath(use.path!)} ) && chmod 600 ${shellPath(use.path!)}`);
  }
  const stdin = uses.find((use) => use.as === "stdin");
  const body = `{\n${command}\n}`;
  const capture = captureTo === undefined ? "" : captureTo === "-" ? "" : ` > ${shellPath(captureTo)}`;
  const run = `${stdin ? `${decoded(stdin.value)} | ` : ""}${body}${capture}`;
  lines.push(captureTo !== undefined && captureTo !== "-" ? `( umask 077; ${run} )` : run);
  return lines.join("\n");
}

export function capturedValue(stdout: string): string | null {
  const value = stdout.replace(/\r?\n$/, "");
  if (!value.trim() || value.length > VAULT_SECRET_MAX) return null;
  return value;
}

export function maskValues<T>(value: T, secrets: readonly string[]): T {
  const hidden = [...new Set(secrets.flatMap((secret) => secret ? [secret, Buffer.from(secret, "utf8").toString("base64")] : []))]
    .sort((a, b) => b.length - a.length);
  if (!hidden.length) return value;
  const mask = (item: unknown): unknown => {
    if (typeof item === "string") return hidden.reduce((text, secret) => text.split(secret).join("••••"), item);
    if (Array.isArray(item)) return item.map(mask);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, mask(entry)]));
    return item;
  };
  return mask(value) as T;
}

export class CommandSecrets {
  private readonly held = new Map<string, { secrets: string[]; capture?: { name: string; path: string; by: string }; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 24 * 60 * 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  remember(commandId: string, secrets: readonly string[], capture?: { name: string; path: string; by: string }): void {
    this.prune();
    this.held.set(commandId, { secrets: [...secrets], ...(capture ? { capture } : {}), at: this.now() });
  }

  secrets(commandId: string | undefined): string[] {
    return commandId ? this.held.get(commandId)?.secrets ?? [] : [];
  }

  takeCapture(commandId: string): { name: string; path: string; by: string } | undefined {
    const entry = this.held.get(commandId);
    const capture = entry?.capture;
    if (entry && capture) delete entry.capture;
    return capture;
  }

  add(commandId: string, secret: string): void {
    this.held.get(commandId)?.secrets.push(secret);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.held) if (entry.at < cutoff) this.held.delete(id);
  }
}
