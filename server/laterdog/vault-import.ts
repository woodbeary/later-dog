import { vaultSite } from "../../shared/vault.ts";

export const VAULT_IMPORT_ROWS = 5_000;

export interface ImportedLogin {
  site: string;
  username: string;
  password: string;
  note?: string;
}

const COLUMNS = {
  site: ["url", "website", "login_uri", "uri", "web site", "login url", "hostname", "site", "urls"],
  username: ["username", "login_username", "user name", "user", "login", "email", "email address", "login name"],
  password: ["password", "login_password"],
  note: ["notes", "note", "extra", "comments"],
  type: ["type"],
} as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char !== "\"") field += char;
      else if (source[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else quoted = false;
    } else if (char === "\"" && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

function column(header: readonly string[], names: readonly string[]): number {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

export function importedLogins(text: string): { logins: ImportedLogin[]; skipped: number } | { error: string } {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const at = {
    site: column(header, COLUMNS.site),
    username: column(header, COLUMNS.username),
    password: column(header, COLUMNS.password),
    note: column(header, COLUMNS.note),
    type: column(header, COLUMNS.type),
  };
  if (at.site < 0 || at.password < 0) {
    return { error: "This file doesn't look like a password export. It needs a column for each login's website and one for its password." };
  }
  const logins: ImportedLogin[] = [];
  let skipped = 0;
  for (const cells of rows.slice(1, VAULT_IMPORT_ROWS + 1)) {
    const type = at.type >= 0 ? (cells[at.type] ?? "").trim().toLowerCase() : "";
    const address = (cells[at.site] ?? "").trim().split(/[\s,]+/)[0] ?? "";
    const site = vaultSite(address);
    const password = (cells[at.password] ?? "").replace(/\r/g, "");
    if ((type && type !== "login") || !site || !password) {
      skipped += 1;
      continue;
    }
    const note = at.note >= 0 ? cells[at.note]?.trim() : undefined;
    logins.push({ site, username: (at.username >= 0 ? cells[at.username] ?? "" : "").trim(), password, ...(note ? { note } : {}) });
  }
  skipped += Math.max(0, rows.length - 1 - VAULT_IMPORT_ROWS);
  return { logins, skipped };
}
