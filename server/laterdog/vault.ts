import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { domainToUnicode } from "node:url";
import { fitsOnOneLine } from "../../shared/bot-profile.ts";
import {
  VAULT_DETAIL_CHARS,
  VAULT_DETAIL_KEYS,
  VAULT_MAX_LOGINS,
  VAULT_NOTE_CHARS,
  VAULT_VALUE_CHARS,
  vaultSite,
  type VaultDetails,
  type VaultDetailsView,
  type VaultImportResult,
  type VaultLogin,
  type VaultOffers,
  type VaultUnavailable,
  type VaultView,
} from "../../shared/vault.ts";
import { writeFileAtomic } from "../atomic.ts";

const FILE_VERSION = 1;
const KEY_BYTES = 32;

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

interface StoredLogin {
  id: string;
  meta: Sealed;
  secret: Sealed;
  createdAt: number;
  updatedAt: number;
  usedAt?: number;
}

interface LoginMeta {
  site: string;
  username: string;
  note?: string;
}

export interface LoginInput {
  site: unknown;
  username: unknown;
  password: unknown;
  note?: unknown;
}

export interface SavedCredentials {
  site: string;
  username: string;
  password: string;
}

export class VaultInputError extends Error {}

export function cloudVaultKey(bootstrapSecret: string, machineId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(bootstrapSecret, "base64url"), `laterdog-vault:${machineId}`, "laterdog-vault-v1", KEY_BYTES));
}

export function testVaultKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === KEY_BYTES ? key : null;
}

const part = (id: string, name: "meta" | "secret") => Buffer.from(`laterdog-vault-v1:${id}:${name}`);
const DETAILS_PART = Buffer.from("laterdog-vault-v1:details");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function seal(key: Buffer, value: unknown, aad: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function unseal<T>(key: Buffer, sealed: Sealed, aad: Buffer): T {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8")) as T;
}

function cleanSite(raw: unknown): string {
  const site = vaultSite(raw);
  if (!site) throw new VaultInputError("Use the site's own address, for example example.com.");
  return site;
}

function cleanUsername(raw: unknown): string {
  const username = typeof raw === "string" ? raw.trim() : "";
  if (username.length > VAULT_VALUE_CHARS) throw new VaultInputError("The username is too long.");
  if (!fitsOnOneLine(username)) throw new VaultInputError("The username has characters that cannot be typed.");
  return username;
}

function cleanPassword(raw: unknown): string {
  const password = typeof raw === "string" ? raw : "";
  if (!password) throw new VaultInputError("Add the password.");
  if (password.length > VAULT_VALUE_CHARS) throw new VaultInputError("The password is too long.");
  if (!fitsOnOneLine(password)) throw new VaultInputError("The password has characters that cannot be typed.");
  return password;
}

function cleanNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const note = [...raw].map((char) => (fitsOnOneLine(char) ? char : " ")).join("").replace(/\s+/g, " ").trim().slice(0, VAULT_NOTE_CHARS).trim();
  return note || undefined;
}

function cleanDetails(raw: unknown): VaultDetails {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const details: VaultDetails = {};
  for (const key of VAULT_DETAIL_KEYS) {
    const value = typeof record[key] === "string" ? [...record[key]].map((char) => (fitsOnOneLine(char) ? char : " ")).join("").replace(/\s+/g, " ").trim() : "";
    if (!value) continue;
    if (value.length > VAULT_DETAIL_CHARS) throw new VaultInputError(`Keep each detail under ${VAULT_DETAIL_CHARS} characters.`);
    if (key === "email" && !EMAIL.test(value)) throw new VaultInputError("That email address doesn't look right.");
    details[key] = value;
  }
  return details;
}

function withNote(meta: LoginMeta, note: string | undefined, previous?: string): LoginMeta {
  const kept = note ?? previous;
  return kept ? { ...meta, note: kept } : meta;
}

const CONFUSABLE: Readonly<Record<string, string>> = {
  "0": "o", "1": "l", "3": "e", "5": "s", "@": "a",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ӏ": "l",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t", "κ": "k", "ι": "i", "ı": "i", "ɡ": "g", "ո": "n", "ⅼ": "l",
};

function skeleton(label: string): string {
  const unicode = label.startsWith("xn--") ? domainToUnicode(label) || label : label;
  return [...unicode.normalize("NFKC").toLowerCase()]
    .map((char) => CONFUSABLE[char] ?? char)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[^a-z0-9-]/g, "");
}

function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const restA = a.slice(start, endA);
  const restB = b.slice(start, endB);
  if (restA.length <= 1 && restB.length <= 1) return true;
  return restA.length === 2 && restB.length === 2 && restA[0] === restB[1] && restA[1] === restB[0];
}

export function lookalikeSite(host: string, savedSites: Iterable<string>): string | null {
  const site = vaultSite(host);
  if (!site) return null;
  const mine = skeleton(site.split(".")[0]!);
  const words = mine.split("-").filter(Boolean);
  for (const saved of savedSites) {
    if (saved === site) continue;
    const theirs = skeleton(saved.split(".")[0]!);
    if (theirs.length < 4) continue;
    if (mine === theirs || words.includes(theirs) || mine.startsWith(theirs) || mine.endsWith(theirs)) return saved;
    if (theirs.length >= 5 && oneEditApart(mine, theirs)) return saved;
  }
  return null;
}

export class VaultStore {
  private readonly file: string;
  private readonly key: Buffer | null;
  private readonly now: () => number;
  private stored: StoredLogin[] = [];
  private readonly metas = new Map<string, LoginMeta>();
  private sealedDetails: Sealed | undefined;
  private shownDetails: VaultDetails = {};
  private problem: VaultUnavailable | null;

  constructor(file: string, key: Buffer | null, now: () => number = Date.now) {
    this.file = file;
    this.key = key && key.length === KEY_BYTES ? key : null;
    this.now = now;
    this.problem = this.key ? null : "cloud-only";
    if (this.key) this.load(this.key);
  }

  get available(): boolean {
    return this.problem === null;
  }

  view(): VaultView {
    return { available: this.available, ...(this.problem ? { reason: this.problem } : {}), logins: this.logins() };
  }

  details(): VaultDetailsView {
    return { available: this.available, details: this.available ? { ...this.shownDetails } : {} };
  }

  saveDetails(raw: unknown): VaultDetails {
    const key = this.writable();
    this.writeDetails(key, cleanDetails(raw));
    this.persist();
    return { ...this.shownDetails };
  }

  addDetails(raw: unknown): VaultDetails {
    const key = this.writable();
    this.writeDetails(key, { ...this.shownDetails, ...cleanDetails(raw) });
    this.persist();
    return { ...this.shownDetails };
  }

  offers(host: string): VaultOffers {
    if (!this.available) return { available: false, logins: [], lookalike: null };
    const logins = this.matching(host);
    if (logins.length) return { available: true, logins, lookalike: null };
    return { available: true, logins, lookalike: lookalikeSite(host, new Set([...this.metas.values()].map((meta) => meta.site))) };
  }

  matching(host: string): VaultLogin[] {
    const site = vaultSite(host);
    return site ? this.logins().filter((login) => login.site === site) : [];
  }

  save(input: LoginInput): { login: VaultLogin; replaced: boolean } {
    const key = this.writable();
    const meta: LoginMeta = { site: cleanSite(input.site), username: cleanUsername(input.username) };
    const note = cleanNote(input.note);
    const password = cleanPassword(input.password);
    const existing = this.find(meta.site, meta.username);
    if (existing) {
      this.write(key, existing, withNote(meta, note, this.metas.get(existing.id)?.note), password);
      this.persist();
      return { login: this.summary(existing), replaced: true };
    }
    if (this.stored.length >= VAULT_MAX_LOGINS) throw new VaultInputError(`Your vault holds up to ${VAULT_MAX_LOGINS} logins. Remove some first.`);
    const login = this.add(key, withNote(meta, note), password);
    this.persist();
    return { login: this.summary(login), replaced: false };
  }

  update(id: string, patch: Partial<LoginInput>): VaultLogin | null {
    const key = this.writable();
    const login = this.stored.find((candidate) => candidate.id === id);
    if (!login) return null;
    const previous = this.metas.get(id)!;
    const meta: LoginMeta = {
      site: patch.site === undefined ? previous.site : cleanSite(patch.site),
      username: patch.username === undefined ? previous.username : cleanUsername(patch.username),
    };
    const note = patch.note === undefined ? previous.note : cleanNote(patch.note);
    if (note) meta.note = note;
    const clash = this.find(meta.site, meta.username);
    if (clash && clash.id !== id) throw new VaultInputError("You already saved this login.");
    const password = patch.password === undefined ? null : cleanPassword(patch.password);
    if (password === null) {
      login.meta = seal(key, meta, part(id, "meta"));
      login.updatedAt = this.now();
      this.metas.set(id, meta);
    } else {
      this.write(key, login, meta, password);
    }
    this.persist();
    return this.summary(login);
  }

  remove(id: string): boolean {
    this.writable();
    const index = this.stored.findIndex((login) => login.id === id);
    if (index < 0) return false;
    this.stored.splice(index, 1);
    this.metas.delete(id);
    this.persist();
    return true;
  }

  credentials(id: string): SavedCredentials | null {
    if (!this.available || !this.key) return null;
    const login = this.stored.find((candidate) => candidate.id === id);
    const meta = this.metas.get(id);
    if (!login || !meta) return null;
    let password: string;
    try {
      password = unseal<{ password: string }>(this.key, login.secret, part(id, "secret")).password;
    } catch {
      return null;
    }
    login.usedAt = this.now();
    this.persist();
    return { site: meta.site, username: meta.username, password };
  }

  importLogins(candidates: readonly { site: string; username: string; password: string; note?: string }[], skipped = 0): VaultImportResult {
    const key = this.writable();
    const result: VaultImportResult = { added: 0, updated: 0, skipped, full: 0 };
    for (const candidate of candidates) {
      let meta: LoginMeta;
      let password: string;
      try {
        meta = { site: cleanSite(candidate.site), username: cleanUsername(candidate.username) };
        password = cleanPassword(candidate.password);
      } catch {
        result.skipped += 1;
        continue;
      }
      const note = cleanNote(candidate.note);
      const existing = this.find(meta.site, meta.username);
      if (existing) {
        if (this.passwordOf(key, existing) === password) {
          result.skipped += 1;
          continue;
        }
        this.write(key, existing, withNote(meta, note, this.metas.get(existing.id)?.note), password);
        result.updated += 1;
        continue;
      }
      if (this.stored.length >= VAULT_MAX_LOGINS) {
        result.full += 1;
        continue;
      }
      this.add(key, withNote(meta, note), password);
      result.added += 1;
    }
    if (result.added || result.updated) this.persist();
    return result;
  }

  private load(key: Buffer): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; logins?: unknown; details?: Sealed };
      if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.logins)) throw new Error("unknown vault file");
      const logins = parsed.logins as StoredLogin[];
      for (const login of logins) this.metas.set(login.id, unseal<LoginMeta>(key, login.meta, part(login.id, "meta")));
      this.stored = logins;
      if (parsed.details) {
        this.shownDetails = cleanDetails(unseal<unknown>(key, parsed.details, DETAILS_PART));
        this.sealedDetails = parsed.details;
      }
    } catch {
      this.stored = [];
      this.metas.clear();
      this.sealedDetails = undefined;
      this.shownDetails = {};
      this.problem = "unreadable";
    }
  }

  private writeDetails(key: Buffer, details: VaultDetails): void {
    this.shownDetails = details;
    this.sealedDetails = Object.keys(details).length ? seal(key, details, DETAILS_PART) : undefined;
  }

  private writable(): Buffer {
    if (this.problem === "unreadable") throw new VaultInputError("Your vault could not be read, so nothing was changed.");
    if (!this.key) throw new VaultInputError("Saved logins are kept in later.dog Cloud.");
    return this.key;
  }

  private find(site: string, username: string): StoredLogin | undefined {
    return this.stored.find((login) => {
      const meta = this.metas.get(login.id);
      return meta?.site === site && meta.username === username;
    });
  }

  private passwordOf(key: Buffer, login: StoredLogin): string | null {
    try {
      return unseal<{ password: string }>(key, login.secret, part(login.id, "secret")).password;
    } catch {
      return null;
    }
  }

  private add(key: Buffer, meta: LoginMeta, password: string): StoredLogin {
    const id = randomUUID();
    const at = this.now();
    const login: StoredLogin = { id, meta: seal(key, meta, part(id, "meta")), secret: seal(key, { password }, part(id, "secret")), createdAt: at, updatedAt: at };
    this.stored.push(login);
    this.metas.set(id, meta);
    return login;
  }

  private write(key: Buffer, login: StoredLogin, meta: LoginMeta, password: string): void {
    login.meta = seal(key, meta, part(login.id, "meta"));
    login.secret = seal(key, { password }, part(login.id, "secret"));
    login.updatedAt = this.now();
    this.metas.set(login.id, meta);
  }

  private summary(login: StoredLogin): VaultLogin {
    const meta = this.metas.get(login.id)!;
    return {
      id: login.id,
      site: meta.site,
      username: meta.username,
      ...(meta.note ? { note: meta.note } : {}),
      updatedAt: login.updatedAt,
      ...(login.usedAt ? { usedAt: login.usedAt } : {}),
    };
  }

  private logins(): VaultLogin[] {
    return this.stored
      .map((login) => this.summary(login))
      .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify({ version: FILE_VERSION, logins: this.stored, ...(this.sealedDetails ? { details: this.sealedDetails } : {}) }), { mode: 0o600 });
  }
}
