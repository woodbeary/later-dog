import { z } from "zod";
import type { SharedComputerOperation } from "../shared-computers.ts";
import { readMacReport } from "./mac-waits.ts";

export const SEND_TEXT_PATH = "/api/internal/mac/send-text";
export const READ_TEXTS_PATH = "/api/internal/mac/read-texts";
export const SEND_EMAIL_PATH = "/api/internal/mac/send-email";
export const MAX_TEXTS = 50;
export const DEFAULT_TEXTS = 20;
export const MAC_SEND_WAIT_MS = 100_000;
export const MAC_READ_WAIT_MS = 40_000;
const TEXT_CHARS = 1500;
const BODY_HEX_CHARS = 3000;
const APPLE_EPOCH_S = 978_307_200;
const CONTACTS_MARK = "__LATERDOG_CONTACTS__";
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SINCE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

const noNul = (value: string) => !value.includes("\0");
const oneLine = (value: string) => !/[\r\n]/.test(value);

export function phoneDigits(value: string): string | null {
  if (!/^\+?[\d\s().-]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export function textHandle(value: string): string | null {
  const trimmed = value.trim();
  if (EMAIL.test(trimmed)) return trimmed.toLowerCase();
  const digits = phoneDigits(trimmed);
  return digits ? `${trimmed.startsWith("+") ? "+" : ""}${digits}` : null;
}

export function handleKey(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return EMAIL.test(trimmed) ? trimmed.toLowerCase() : null;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

const emailAddress = z.string().trim().max(254).regex(EMAIL, "must be an email address");

export const sendTextInput = z.object({
  to: z.string().trim().min(2).max(120).refine(noNul, "can't contain NUL characters"),
  text: z.string().trim().min(1).max(4000).refine(noNul, "can't contain NUL characters"),
  computer_id: z.string().uuid().optional(),
}).strict();

export const readTextsInput = z.object({
  with: z.string().trim().min(2).max(120).refine(noNul, "can't contain NUL characters").optional(),
  since: z.string().trim().regex(SINCE, "must be a date like 2026-10-29 or 2026-10-29 14:30").optional(),
  limit: z.number().int().min(1).max(MAX_TEXTS).optional(),
  computer_id: z.string().uuid().optional(),
}).strict();

export const sendEmailInput = z.object({
  to: z.array(emailAddress).min(1).max(10),
  cc: z.array(emailAddress).max(10).optional(),
  subject: z.string().trim().min(1).max(200).refine(noNul, "can't contain NUL characters").refine(oneLine, "must be one line"),
  body: z.string().trim().min(1).max(20_000).refine(noNul, "can't contain NUL characters"),
  computer_id: z.string().uuid().optional(),
}).strict();

export type SendTextInput = z.infer<typeof sendTextInput>;
export type ReadTextsInput = z.infer<typeof readTextsInput>;
export type SendEmailInput = z.infer<typeof sendEmailInput>;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const APP_MARK = "__LATERDOG_APP__";
const NAME_APP = `printf '${APP_MARK} %s\\n' "$(ps -o comm= -p $PPID)"`;
const READ_FIELDS = `fields=(); while IFS= read -r -d '' field; do fields+=("$field"); done`;

export interface LendingApp {
  label: string;
  path?: string;
  restart: string;
}

export function lendingApp(output: string): { app: LendingApp; rest: string } {
  const lines = output.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${APP_MARK} `));
  const path = at < 0 ? "" : lines[at]!.slice(APP_MARK.length + 1).trim();
  const rest = at < 0 ? output : [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n");
  const dev = "choose later.dog Dev → Restart later.dog Dev";
  if (/(^|\/)node$/.test(path)) return { app: { label: "node", ...(path.startsWith("/") ? { path } : {}), restart: dev }, rest };
  if (/later\.dog Dev/i.test(path)) return { app: { label: "later.dog Dev", restart: dev }, rest };
  return { app: { label: "later.dog", restart: "quit and reopen later.dog" }, rest };
}

function scriptReadingFields(lines: readonly string[]): string {
  return `${NAME_APP}; ${READ_FIELDS}; exec /usr/bin/osascript ${lines.map((line) => `-e ${shellQuote(line)}`).join(" ")} -- "\${fields[@]}"`;
}

export function fieldsInput(fields: readonly string[]): string {
  return fields.map((field) => `${field}\0`).join("");
}

export const SEND_TEXT_COMMAND = scriptReadingFields([
  "on run argv",
  "set theTarget to item 1 of argv",
  "set theText to item 2 of argv",
  "tell application \"Messages\"",
  "try",
  "send theText to participant theTarget of (1st account whose service type = iMessage)",
  "return \"iMessage\"",
  "on error errorText number errorNumber",
  "if errorNumber is -1743 then error errorText number errorNumber",
  "end try",
  "send theText to participant theTarget of (1st account whose service type = SMS)",
  "return \"SMS\"",
  "end tell",
  "end run",
]);

export const SEND_EMAIL_COMMAND = scriptReadingFields([
  "on run argv",
  "tell application \"Mail\"",
  "if (count of accounts) is 0 then error \"Mail has no account to send from.\" number 5001",
  "set theMessage to make new outgoing message with properties {subject:(item 1 of argv), content:(item 2 of argv), visible:false}",
  "tell theMessage",
  "repeat with i from 3 to count of argv",
  "set theAddress to item i of argv",
  "if theAddress starts with \"cc:\" then",
  "make new cc recipient at end of cc recipients with properties {address:(text 4 thru -1 of theAddress)}",
  "else",
  "make new to recipient at end of to recipients with properties {address:(text 4 thru -1 of theAddress)}",
  "end if",
  "end repeat",
  "end tell",
  "if not (send theMessage) then error \"Mail didn't send it.\" number 5002",
  "end tell",
  "return \"sent\"",
  "end run",
]);

export function sendTextFields(input: { to: string; text: string }): string {
  return fieldsInput([input.to, input.text]);
}

export function sendEmailFields(input: Pick<SendEmailInput, "to" | "cc" | "subject" | "body">): string {
  return fieldsInput([input.subject, input.body, ...input.to.map((address) => `to:${address}`), ...(input.cc ?? []).map((address) => `cc:${address}`)]);
}

const SENT_SECONDS = "(CASE WHEN m.date > 100000000000 THEN m.date / 1000000000 ELSE m.date END)";

function handleMatch(key: string): string {
  return key.includes("@") ? `lower(h.id) = '${key}'` : `h.id LIKE '%${key}'`;
}

export function readTextsCommand(query: { since?: string; handles?: readonly string[]; limit: number }): string {
  const keys = (query.handles ?? []).filter((key) => /^\d{7,10}$/.test(key) || EMAIL.test(key));
  const since = query.since && SINCE.test(query.since)
    ? ` AND m.date > (CAST(strftime('%s', '${query.since}', 'utc') AS INTEGER) - ${APPLE_EPOCH_S}) * 1000000000`
    : "";
  const who = !query.handles ? "" : keys.length ? ` AND (${keys.map(handleMatch).join(" OR ")})` : " AND 0";
  const sql = [
    `SELECT strftime('%Y-%m-%d %H:%M', ${SENT_SECONDS} + ${APPLE_EPOCH_S}, 'unixepoch', 'localtime') AS at,`,
    "m.is_from_me AS fromMe, h.id AS handle, NULLIF(c.display_name, '') AS chat,",
    `substr(m.text, 1, ${TEXT_CHARS}) AS text,`,
    `CASE WHEN m.text IS NULL OR m.text = '' THEN substr(hex(m.attributedBody), 1, ${BODY_HEX_CHARS}) END AS body,`,
    "m.cache_has_attachments AS files",
    "FROM message m",
    "LEFT JOIN handle h ON h.ROWID = m.handle_id",
    "LEFT JOIN chat_message_join j ON j.message_id = m.ROWID",
    "LEFT JOIN chat c ON c.ROWID = j.chat_id",
    `WHERE m.associated_message_type = 0 AND m.item_type = 0${since}${who}`,
    `ORDER BY m.date DESC LIMIT ${Math.max(1, Math.min(MAX_TEXTS, Math.floor(query.limit)))};`,
  ].join(" ");
  return `${NAME_APP}; /usr/bin/sqlite3 -readonly -json "$HOME/Library/Messages/chat.db" ${shellQuote(sql)}`;
}

const ADDRESS_BOOKS = `"$HOME/Library/Application Support/AddressBook/AddressBook-v22.abcddb" "$HOME/Library/Application Support/AddressBook/Sources/"*/AddressBook-v22.abcddb`;
const PERSON = "TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, '')) AS person, r.ZNICKNAME AS nickname, r.ZORGANIZATION AS organization";
const NUMBER_DIGITS = [" ", "-", "(", ")", ".", "+"].reduce((sql, mark) => `replace(${sql}, '${mark}', '')`, "replace(p.ZFULLNUMBER, char(160), '')");

function contactsCommand(sql: string): string {
  return `${NAME_APP}; for book in ${ADDRESS_BOOKS}; do [ -f "$book" ] || continue; echo ${CONTACTS_MARK}; /usr/bin/sqlite3 -readonly -json "$book" ${shellQuote(sql)} 2>&1; done; true`;
}

export function contactsForHandlesCommand(keys: readonly string[]): string | null {
  const numbers = keys.filter((key) => /^\d{7,10}$/.test(key));
  const emails = keys.filter((key) => EMAIL.test(key));
  if (!numbers.length && !emails.length) return null;
  const parts = [
    ...(numbers.length ? [`SELECT ${PERSON}, p.ZFULLNUMBER AS phone, NULL AS email, p.ZLABEL AS label FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER WHERE substr(${NUMBER_DIGITS}, -10) IN (${numbers.map((key) => `'${key}'`).join(", ")})`] : []),
    ...(emails.length ? [`SELECT ${PERSON}, NULL AS phone, e.ZADDRESS AS email, e.ZLABEL AS label FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER WHERE lower(e.ZADDRESS) IN (${emails.map((key) => `'${key}'`).join(", ")})`] : []),
  ];
  return contactsCommand(`${parts.join(" UNION ALL ")};`);
}

export function contactsNamedCommand(name: string): string {
  const words = name.toLowerCase().replace(/[%_\0]/g, "").replace(/'/g, "''").trim();
  const like = `'%${words}%'`;
  const match = [
    `lower(TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, ''))) LIKE ${like}`,
    `lower(COALESCE(r.ZNICKNAME, '')) LIKE ${like}`,
    `lower(COALESCE(r.ZORGANIZATION, '')) LIKE ${like}`,
  ].join(" OR ");
  return contactsCommand([
    `SELECT ${PERSON}, p.ZFULLNUMBER AS phone, NULL AS email, p.ZLABEL AS label FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK WHERE ${match}`,
    `UNION ALL SELECT ${PERSON}, NULL AS phone, e.ZADDRESS AS email, e.ZLABEL AS label FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK WHERE ${match}`,
    "LIMIT 40;",
  ].join(" "));
}

export interface Contact {
  name: string;
  key: string;
  address: string;
  mobile?: boolean;
}

interface ContactRow {
  person?: string | null;
  nickname?: string | null;
  organization?: string | null;
  phone?: string | null;
  email?: string | null;
  label?: string | null;
}

export function contactsFrom(output: string): Contact[] {
  const contacts: Contact[] = [];
  for (const chunk of output.split(CONTACTS_MARK).slice(1)) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith("[")) continue;
    let rows: ContactRow[];
    try {
      rows = JSON.parse(trimmed) as ContactRow[];
    } catch {
      continue;
    }
    for (const row of rows) {
      const name = [row.person, row.nickname, row.organization].map((value) => value?.trim()).find(Boolean);
      const address = (row.phone ?? row.email ?? "").trim();
      const key = address ? handleKey(address) : null;
      if (name && key) contacts.push({ name, key, address, ...(row.phone && /mobile|iphone|cell/i.test(row.label ?? "") ? { mobile: true } : {}) });
    }
  }
  return contacts;
}

export type Recipient = { to: string; shown: string } | { error: string; status: number };

export function recipientFrom(name: string, contacts: readonly Contact[]): Recipient {
  const unique = [...new Map(contacts.map((contact) => [contact.key, contact])).values()];
  if (!unique.length) return { error: MAC_MESSAGES_WORDS.noRecipient(name), status: 404 };
  const phones = unique.filter((contact) => !contact.key.includes("@"));
  const mobiles = phones.filter((contact) => contact.mobile);
  const choice = unique.length === 1 ? unique[0] : phones.length === 1 ? phones[0] : mobiles.length === 1 ? mobiles[0] : undefined;
  const to = choice ? textHandle(choice.address) : null;
  if (!choice || !to) return { error: MAC_MESSAGES_WORDS.manyRecipients(name, unique.map((contact) => `${contact.name} ${contact.address}`)), status: 409 };
  return { to, shown: `${choice.name} (${to})` };
}

export function attributedText(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const bytes = Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, "hex");
  const marker = bytes.indexOf("NSString");
  if (marker < 0) return null;
  let at = marker + "NSString".length + 5;
  if (at >= bytes.length) return null;
  let length = bytes[at]!;
  at += 1;
  if (length === 0x81 || length === 0x82) {
    const size = length === 0x81 ? 2 : 3;
    if (at + size > bytes.length) return null;
    length = bytes.readUIntLE(at, size);
    at += size;
  }
  if (at + length <= bytes.length) return bytes.subarray(at, at + length).toString("utf8");
  return `${bytes.subarray(at).toString("utf8").replace(/�+$/, "")}…`;
}

export interface TextMessage {
  at: string;
  from: string;
  to?: string;
  handle?: string;
  chat?: string;
  text: string;
}

interface TextRow {
  at?: string | null;
  fromMe?: number | null;
  handle?: string | null;
  chat?: string | null;
  text?: string | null;
  body?: string | null;
  files?: number | null;
}

export function textsFrom(output: string): TextMessage[] {
  const trimmed = lendingApp(output).rest.trim();
  if (!trimmed) return [];
  const rows = JSON.parse(trimmed) as TextRow[];
  if (!Array.isArray(rows)) throw new Error("not a list of texts");
  return rows.reverse().flatMap((row) => {
    const words = (row.text || attributedText(row.body) || "").replace(/￼/g, "").trim();
    const text = words || (row.files ? "(attachment)" : "");
    if (!text) return [];
    const handle = row.handle?.trim() || undefined;
    return [{
      at: row.at ?? "",
      from: row.fromMe ? "me" : handle ?? "someone",
      ...(row.fromMe && handle ? { to: handle } : {}),
      ...(handle ? { handle } : {}),
      ...(row.chat ? { chat: row.chat } : {}),
      text,
    }];
  });
}

export function namedTexts(texts: readonly TextMessage[], contacts: readonly Contact[]): TextMessage[] {
  const names = new Map(contacts.map((contact) => [contact.key, contact.name]));
  const nameOf = (handle: string) => {
    const key = handleKey(handle);
    return (key && names.get(key)) ?? handle;
  };
  return texts.map((text) => ({
    ...text,
    ...(text.from !== "me" && text.handle && text.from === text.handle ? { from: nameOf(text.handle) } : {}),
    ...(text.to ? { to: nameOf(text.to) } : {}),
  }));
}

function lastLine(output: string): string {
  const line = output.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

export const MAC_MESSAGES_WORDS = {
  automation: (app: string, by: LendingApp) => `macOS hasn't let ${by.label} control ${app} on the Mac yet. Tell the person: on the Mac, choose OK when macOS asks whether ${by.label} may control ${app}, or turn on ${app} under ${by.label} in System Settings → Privacy & Security → Automation. Then try again.`,
  fullDiskAccess: (by: LendingApp) => `Reading texts needs Full Disk Access for ${by.label} on the Mac${shared(by)}. Tell the person: on the Mac, open System Settings → Privacy & Security → Full Disk Access, ${grant(by)}, then ${by.restart}, and try again.`,
  noMail: "Mail on the Mac has no account to send from. Tell the person to add one in Mail, then try again.",
  noSms: "Messages on the Mac couldn't send to that number: it isn't on iMessage, and this Mac can't send SMS, which needs Text Message Forwarding turned on for it on their iPhone. Tell the person.",
  stillWaiting: (app: string, by: LendingApp) => `${app} on the Mac didn't finish in time, so later.dog stopped waiting. macOS may be asking on the Mac whether ${by.label} can control ${app}: tell the person to answer it and to check ${app} before you try again.`,
  readTimedOut: "Reading texts on the Mac took too long, so later.dog stopped. Try again with a smaller limit.",
  failed: (app: string, output: string) => `${app} on the Mac couldn't do it${lastLine(output) ? `: ${lastLine(output)}` : ""}. Tell the person in one line.`,
  unreadable: "The Mac answered with something later.dog couldn't read. Try once more; if it happens again, tell the person.",
  sentText: (to: string, via: string, mac: string) => `Sent to ${to} through ${via} from Messages on ${mac}. Messages doesn't confirm delivery here.`,
  sentEmail: (to: readonly string[], mac: string) => `Sent the email to ${to.join(", ")} from Mail on ${mac}.`,
  noTexts: "No texts match.",
  noContact: (name: string) => `No contact on the Mac matches ${name}. Ask the person for the number or email, or try another spelling.`,
  notSent: "Nothing was sent.",
  noRecipient: (name: string) => `No contact on the Mac matches ${name}. Ask the person for the number or email address.`,
  manyRecipients: (name: string, choices: readonly string[]) => `${name} matches more than one number or address in Contacts: ${choices.join("; ")}. Ask the person which one, then send to that number or address.`,
  contactsNeedAccess: (by: LendingApp) => `Finding a name in Contacts on the Mac needs Full Disk Access for ${by.label}${shared(by)}. Ask the person for the number, or tell them: on the Mac, open System Settings → Privacy & Security → Full Disk Access, ${grant(by)}, then ${by.restart}.`,
} as const;

function shared(by: LendingApp): string {
  return by.label === "node" ? ", the program later.dog Dev's Mac connection runs on; every script run by that node gets the same access" : "";
}

function grant(by: LendingApp): string {
  return by.path ? `click +, press Command-Shift-G, paste ${by.path} and choose Open` : `turn on ${by.label}`;
}

const NO_DISK_ACCESS = /unable to open database|authorization denied|operation not permitted/i;

export function macMessagesError(output: string, app: "Messages" | "Mail" | "texts"): string | null {
  const by = lendingApp(output).app;
  if (/-1743|not authori[sz]ed to send apple events/i.test(output)) return MAC_MESSAGES_WORDS.automation(app === "texts" ? "Messages" : app, by);
  if (app === "texts" && NO_DISK_ACCESS.test(output)) return MAC_MESSAGES_WORDS.fullDiskAccess(by);
  if (app === "Mail" && /\(5001\)|has no account/i.test(output)) return MAC_MESSAGES_WORDS.noMail;
  if (app === "Messages" && /service type = SMS|account 1 whose service type|\(-1728\)/i.test(output)) return MAC_MESSAGES_WORDS.noSms;
  return null;
}

export type MacAsk =
  | { action: "send_text"; arguments: { to: string; text: string } }
  | { action: "read_texts"; arguments: { with?: string; since?: string } }
  | { action: "send_email"; arguments: { to: string[]; cc?: string[]; subject: string; body: string } };

export interface MessagesMac {
  name: string;
  never: boolean;
  approve(ask: MacAsk): Promise<void>;
  run(operation: SharedComputerOperation): Promise<unknown>;
  active(): boolean;
}

export interface CommandEnd {
  finished: boolean;
  exitCode: number | null;
  output: string;
}

export interface MessagesAnswer {
  status: number;
  body: Record<string, unknown>;
}

function report(result: unknown) {
  const parsed = readMacReport(result);
  if (!parsed) throw Object.assign(new Error(MAC_MESSAGES_WORDS.unreadable), { status: 502 });
  return parsed;
}

export async function runOnMac(
  mac: Pick<MessagesMac, "run" | "active">,
  command: string,
  options: { input?: string; waitMs: number; now?: () => number },
): Promise<CommandEnd> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.waitMs;
  let current = report(await mac.run({ action: "run_command", command, wait_seconds: options.input === undefined ? 10 : 0 }));
  const commandId = typeof current.command_id === "string" ? current.command_id : undefined;
  let output = typeof current.output === "string" ? current.output : "";
  if (options.input !== undefined && current.running && commandId) {
    await mac.run({ action: "command_input", command_id: commandId, input: options.input, close_input: true }).catch(() => undefined);
  }
  while (current.running && commandId) {
    if (!mac.active() || now() >= deadline) {
      await mac.run({ action: "command_stop", command_id: commandId }).catch(() => undefined);
      return { finished: false, exitCode: null, output };
    }
    const waitSeconds = Math.max(1, Math.min(30, Math.ceil((deadline - now()) / 1000)));
    current = report(await mac.run({ action: "command_output", command_id: commandId, wait_seconds: waitSeconds }));
    output += typeof current.output === "string" ? current.output : "";
  }
  return { finished: true, exitCode: typeof current.exitCode === "number" ? current.exitCode : null, output };
}

const failed = (error: string, status = 409): MessagesAnswer => ({ status, body: { error } });
const notSent = (error: string, status = 409): MessagesAnswer => failed(`${MAC_MESSAGES_WORDS.notSent} ${error}`, status);

async function recipient(name: string, mac: MessagesMac): Promise<Recipient> {
  const to = textHandle(name);
  if (to) return { to, shown: to };
  const found = await readContacts(mac, contactsNamedCommand(name));
  if (found.refused) return { error: MAC_MESSAGES_WORDS.contactsNeedAccess(found.by), status: 403 };
  return recipientFrom(name, found.contacts);
}

export async function sendText(input: SendTextInput, mac: MessagesMac): Promise<MessagesAnswer> {
  const chosen = await recipient(input.to, mac);
  if ("error" in chosen) return notSent(chosen.error, chosen.status);
  await mac.approve({ action: "send_text", arguments: { to: chosen.shown, text: input.text } });
  const end = await runOnMac(mac, SEND_TEXT_COMMAND, { input: sendTextFields({ to: chosen.to, text: input.text }), waitMs: MAC_SEND_WAIT_MS });
  if (!end.finished) return failed(MAC_MESSAGES_WORDS.stillWaiting("Messages", lendingApp(end.output).app), 504);
  if (end.exitCode !== 0) return notSent(macMessagesError(end.output, "Messages") ?? MAC_MESSAGES_WORDS.failed("Messages", lendingApp(end.output).rest));
  const via = /\bSMS\b/.test(end.output) ? "SMS" : "iMessage";
  return { status: 200, body: { text: MAC_MESSAGES_WORDS.sentText(chosen.shown, via, mac.name) } };
}

export async function sendEmail(input: SendEmailInput, mac: MessagesMac): Promise<MessagesAnswer> {
  await mac.approve({
    action: "send_email",
    arguments: { to: input.to, ...(input.cc?.length ? { cc: input.cc } : {}), subject: input.subject, body: input.body },
  });
  const end = await runOnMac(mac, SEND_EMAIL_COMMAND, { input: sendEmailFields(input), waitMs: MAC_SEND_WAIT_MS });
  if (!end.finished) return failed(MAC_MESSAGES_WORDS.stillWaiting("Mail", lendingApp(end.output).app), 504);
  if (end.exitCode !== 0) return notSent(macMessagesError(end.output, "Mail") ?? MAC_MESSAGES_WORDS.failed("Mail", lendingApp(end.output).rest));
  return { status: 200, body: { text: MAC_MESSAGES_WORDS.sentEmail([...input.to, ...(input.cc ?? [])], mac.name) } };
}

async function readContacts(mac: MessagesMac, command: string | null): Promise<{ contacts: Contact[]; refused: boolean; by: LendingApp }> {
  if (!command) return { contacts: [], refused: false, by: lendingApp("").app };
  const end = await runOnMac(mac, command, { waitMs: MAC_READ_WAIT_MS });
  return { contacts: contactsFrom(end.output), refused: NO_DISK_ACCESS.test(end.output), by: lendingApp(end.output).app };
}

export async function readTexts(input: ReadTextsInput, mac: MessagesMac): Promise<MessagesAnswer> {
  await mac.approve({ action: "read_texts", arguments: { ...(input.with ? { with: input.with } : {}), ...(input.since ? { since: input.since } : {}) } });
  let handles: string[] | undefined;
  let known: Contact[] = [];
  if (input.with) {
    const direct = textHandle(input.with) ? handleKey(input.with) : null;
    if (direct) {
      handles = [direct];
    } else {
      const named = await readContacts(mac, contactsNamedCommand(input.with));
      if (named.refused) return failed(MAC_MESSAGES_WORDS.fullDiskAccess(named.by), 403);
      if (!named.contacts.length) return { status: 200, body: { texts: [], note: MAC_MESSAGES_WORDS.noContact(input.with) } };
      known = named.contacts;
      handles = [...new Set(known.map((contact) => contact.key))];
    }
  }
  const end = await runOnMac(mac, readTextsCommand({ ...(input.since ? { since: input.since } : {}), ...(handles ? { handles } : {}), limit: input.limit ?? DEFAULT_TEXTS }), { waitMs: MAC_READ_WAIT_MS });
  if (!end.finished) return failed(MAC_MESSAGES_WORDS.readTimedOut, 504);
  if (end.exitCode !== 0) {
    const problem = macMessagesError(end.output, "texts");
    return failed(problem ?? MAC_MESSAGES_WORDS.failed("Messages", lendingApp(end.output).rest), NO_DISK_ACCESS.test(end.output) ? 403 : 409);
  }
  let texts: TextMessage[];
  try {
    texts = textsFrom(end.output);
  } catch {
    return failed(MAC_MESSAGES_WORDS.unreadable, 502);
  }
  const knownKeys = new Set(known.map((contact) => contact.key));
  const unnamed = [...new Set(texts.flatMap((text) => (text.handle ? [handleKey(text.handle)] : [])).filter((key): key is string => key !== null && !knownKeys.has(key)))];
  const more = await readContacts(mac, contactsForHandlesCommand(unnamed)).catch(() => ({ contacts: [] }));
  const named = namedTexts(texts, [...known, ...more.contacts]);
  return { status: 200, body: { texts: named, ...(named.length ? {} : { note: MAC_MESSAGES_WORDS.noTexts }) } };
}
