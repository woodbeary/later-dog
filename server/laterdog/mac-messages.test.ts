import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SharedComputerOperation } from "../shared-computers.ts";
import {
  attributedText, contactsForHandlesCommand, contactsFrom, contactsNamedCommand, handleKey, MAC_MESSAGES_WORDS, macMessagesError,
  namedTexts, readTexts, readTextsCommand, readTextsInput, recipientFrom, runOnMac, SEND_EMAIL_COMMAND, SEND_TEXT_COMMAND, sendEmail, sendEmailFields,
  sendEmailInput, sendText, sendTextFields, sendTextInput, textHandle, textsFrom, type MacAsk, type MessagesMac,
} from "./mac-messages.ts";

const SQLITE = "/usr/bin/sqlite3";
const hasSqlite = existsSync(SQLITE);
const APPLE_EPOCH_S = 978_307_200;

function typedstream(text: string): string {
  const words = Buffer.from(text, "utf8");
  const length = words.length < 0x80
    ? Buffer.from([words.length])
    : Buffer.concat([Buffer.from([0x81]), Buffer.from([words.length & 0xff, words.length >> 8])]);
  return Buffer.concat([
    Buffer.from("040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e6700848408", "hex"),
    Buffer.from("NSString"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    length,
    words,
    Buffer.from("8684026949010c928484840c4e5344696374696f6e617279", "hex"),
  ]).toString("hex");
}

function appleNs(iso: string): string {
  return (BigInt(Date.parse(iso) / 1000 - APPLE_EPOCH_S) * 1_000_000_000n).toString();
}

function bash(command: string, options: { input?: string; home?: string } = {}) {
  const ran = spawnSync("/bin/bash", ["-c", command], {
    input: options.input ?? "",
    env: { ...process.env, TZ: "UTC", ...(options.home ? { HOME: options.home } : {}) },
    encoding: "utf8",
  });
  return { exitCode: ran.status, output: `${ran.stdout}${ran.stderr}` };
}

function localMac(home: string, asked: MacAsk[] = []): MessagesMac {
  return {
    name: "Jo's MacBook Air",
    never: false,
    approve: async (ask) => { asked.push(ask); },
    active: () => true,
    run: async (operation: SharedComputerOperation) => {
      if (operation.action !== "run_command") throw new Error(`unexpected ${operation.action}`);
      const ran = bash(operation.command!, { home });
      return { content: [{ type: "text", text: JSON.stringify({ command_id: "c1", running: false, exitCode: ran.exitCode, output: ran.output }) }] };
    },
  };
}

function report(value: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function scriptedMac(answers: Record<string, unknown>[], options: { active?: () => boolean; refuse?: Error } = {}) {
  const asked: MacAsk[] = [];
  const operations: SharedComputerOperation[] = [];
  const mac: MessagesMac = {
    name: "Jo's MacBook Air",
    never: false,
    approve: async (ask) => {
      asked.push(ask);
      if (options.refuse) throw options.refuse;
    },
    active: options.active ?? (() => true),
    run: async (operation) => {
      operations.push(operation);
      if (operation.action === "command_input" || operation.action === "command_stop") return report({ command_id: "c1", running: true });
      return report(answers.shift() ?? { command_id: "c1", running: false, exitCode: 0, output: "" });
    },
  };
  return { mac, asked, operations };
}

describe("who a text goes to", () => {
  it("takes a phone number in any common shape or an email, and nothing else", () => {
    expect(textHandle("+1 (555) 123-4567")).toBe("+15551234567");
    expect(textHandle("555.123.4567")).toBe("5551234567");
    expect(textHandle("Sam@Example.com")).toBe("sam@example.com");
    expect(textHandle("Mom")).toBeNull();
    expect(textHandle("12345")).toBeNull();
    expect(handleKey("+1 (555) 123-4567")).toBe("5551234567");
    expect(handleKey("Sam@Example.com")).toBe("sam@example.com");
    expect(sendTextInput.safeParse({ to: "Mom", text: "hi" }).success).toBe(true);
    expect(sendTextInput.safeParse({ to: "M", text: "hi" }).success).toBe(false);
    expect(sendTextInput.safeParse({ to: "+15551234567", text: "a\0b" }).success).toBe(false);
    expect(sendTextInput.safeParse({ to: "+15551234567", text: "hi", extra: 1 }).success).toBe(false);
    expect(sendEmailInput.safeParse({ to: ["sam@example.com"], subject: "two\nlines", body: "x" }).success).toBe(false);
    expect(sendEmailInput.safeParse({ to: ["not an address"], subject: "s", body: "x" }).success).toBe(false);
    expect(readTextsInput.safeParse({ since: "yesterday" }).success).toBe(false);
    expect(readTextsInput.safeParse({ with: "Mom", since: "2026-10-29 14:30", limit: 50 }).success).toBe(true);
  });
});

describe("the commands that run on the Mac", () => {
  let folder: string;
  let stub: string;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "laterdog-mac-messages-"));
    stub = join(folder, "osascript");
    writeFileSync(stub, "#!/bin/bash\nwhile [ \"$1\" != \"--\" ]; do shift; done; shift\nfor field in \"$@\"; do printf '%s\\0' \"$field\"; done\n");
    chmodSync(stub, 0o755);
  });

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  const fieldsSeen = (command: string, input: string) => {
    const ran = bash(command.replace("/usr/bin/osascript", stub), { input });
    expect(ran.exitCode).toBe(0);
    return ran.output.split("\0").slice(0, -1);
  };

  it("hands the recipient and words to the script as input, never as part of the command", () => {
    const words = "it's \"fine\" $(touch /tmp/no) `id` -e\nsecond line  ";
    expect(SEND_TEXT_COMMAND).not.toContain("touch");
    expect(fieldsSeen(SEND_TEXT_COMMAND, sendTextFields({ to: "+15551234567", text: words }))).toEqual(["+15551234567", words]);
    const fields = sendEmailFields({ to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Documents for Friday", body: "Héllo 👋\n\n-- me" });
    expect(SEND_EMAIL_COMMAND).not.toMatch(/Documents|Desktop|Downloads/);
    expect(fieldsSeen(SEND_EMAIL_COMMAND, fields)).toEqual(["Documents for Friday", "Héllo 👋\n\n-- me", "to:a@example.com", "to:b@example.com", "cc:c@example.com"]);
  });

  it("keeps a bad filter from widening or breaking the query", () => {
    expect(readTextsCommand({ handles: ["1' OR '1'='1"], limit: 5 })).toContain(" AND 0");
    expect(readTextsCommand({ since: "2026-10-29'; DROP TABLE message; --", limit: 5 })).not.toContain("DROP");
    expect(readTextsCommand({ limit: 500 })).toContain("LIMIT 50;");
    expect(contactsForHandlesCommand(["not-a-key"])).toBeNull();
  });
});

describe.skipIf(!hasSqlite)("reading texts from a Messages database", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "laterdog-mac-texts-"));
    mkdirSync(join(home, "Library/Messages"), { recursive: true });
    const chat = [
      "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);",
      "CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);",
      "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);",
      "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, handle_id INTEGER DEFAULT 0, date INTEGER, is_from_me INTEGER DEFAULT 0, attributedBody BLOB, cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0);",
      "INSERT INTO handle VALUES (1, '+15551234567'), (2, 'sam@example.com');",
      "INSERT INTO chat VALUES (1, '+15551234567', ''), (2, 'chat99', 'Climbing');",
      `INSERT INTO message (ROWID, text, handle_id, date) VALUES (1, 'old news', 1, ${appleNs("2026-10-01T09:00:00Z")});`,
      `INSERT INTO message (ROWID, text, handle_id, date) VALUES (2, 'Dinner at 7?', 1, ${appleNs("2026-10-28T10:00:00Z")});`,
      `INSERT INTO message (ROWID, text, handle_id, date, is_from_me, attributedBody) VALUES (3, NULL, 1, ${appleNs("2026-10-28T10:05:00Z")}, 1, X'${typedstream("Sure, see you then")}');`,
      `INSERT INTO message (ROWID, text, handle_id, date, associated_message_type) VALUES (4, 'Loved “Sure”', 1, ${appleNs("2026-10-28T10:06:00Z")}, 2000);`,
      `INSERT INTO message (ROWID, text, handle_id, date) VALUES (5, 'Sunday?', 2, ${appleNs("2026-10-29T08:00:00Z")});`,
      `INSERT INTO message (ROWID, text, handle_id, date, cache_has_attachments) VALUES (6, char(65532), 2, ${appleNs("2026-10-29T08:01:00Z")}, 1);`,
      `INSERT INTO message (ROWID, text, handle_id, date, item_type) VALUES (7, 'named the conversation', 2, ${appleNs("2026-10-29T08:02:00Z")}, 2);`,
      "INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (1, 3), (1, 4), (2, 5), (2, 6), (2, 7);",
    ].join("\n");
    expect(spawnSync(SQLITE, [join(home, "Library/Messages/chat.db")], { input: chat }).status).toBe(0);
    const books = join(home, "Library/Application Support/AddressBook");
    mkdirSync(join(books, "Sources/ABC"), { recursive: true });
    const tables = [
      "CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);",
      "CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT);",
      "CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZLABEL TEXT);",
    ].join("\n");
    expect(spawnSync(SQLITE, [join(books, "AddressBook-v22.abcddb")], { input: tables }).status).toBe(0);
    const people = [
      tables,
      "INSERT INTO ZABCDRECORD VALUES (1, 'Mom', NULL, NULL, NULL), (2, 'Sam', 'Lee', NULL, NULL), (3, NULL, NULL, NULL, 'Dentist'), (4, 'Ana', 'Ruiz', NULL, NULL);",
      "INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '(555) 123-4567', '_$!<Mobile>!$_'), (2, 3, '+1 555 000 1111', '_$!<Work>!$_'), (3, 1, '555 222 3333', '_$!<Home>!$_'), (4, 4, '555 444 5555', '_$!<Home>!$_'), (5, 4, '555 666 7777', '_$!<Work>!$_');",
      "INSERT INTO ZABCDEMAILADDRESS VALUES (1, 2, 'Sam@Example.com', '_$!<Home>!$_');",
    ].join("\n");
    expect(spawnSync(SQLITE, [join(books, "Sources/ABC/AddressBook-v22.abcddb")], { input: people }).status).toBe(0);
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const query = (input: Parameters<typeof readTextsCommand>[0]) => {
    const ran = bash(readTextsCommand(input), { home });
    expect(ran.exitCode).toBe(0);
    return textsFrom(ran.output);
  };

  it("lists texts oldest first, skipping reactions and conversation events, and reads words kept only in the rich body", () => {
    expect(query({ limit: 20 })).toEqual([
      { at: "2026-10-01 09:00", from: "+15551234567", handle: "+15551234567", text: "old news" },
      { at: "2026-10-28 10:00", from: "+15551234567", handle: "+15551234567", text: "Dinner at 7?" },
      { at: "2026-10-28 10:05", from: "me", to: "+15551234567", handle: "+15551234567", text: "Sure, see you then" },
      { at: "2026-10-29 08:00", from: "sam@example.com", handle: "sam@example.com", chat: "Climbing", text: "Sunday?" },
      { at: "2026-10-29 08:01", from: "sam@example.com", handle: "sam@example.com", chat: "Climbing", text: "(attachment)" },
    ]);
  });

  it("filters by time, by person and by how many", () => {
    expect(query({ since: "2026-10-28 10:01", limit: 20 }).map((text) => text.text)).toEqual(["Sure, see you then", "Sunday?", "(attachment)"]);
    expect(query({ handles: ["5551234567"], limit: 20 }).map((text) => text.text)).toEqual(["old news", "Dinner at 7?", "Sure, see you then"]);
    expect(query({ handles: ["sam@example.com"], limit: 1 }).map((text) => text.text)).toEqual(["(attachment)"]);
    expect(query({ handles: [], limit: 20 })).toEqual([]);
  });

  it("finds people in Contacts by name or by number and email", () => {
    const named = bash(contactsNamedCommand("mom"), { home });
    expect(contactsFrom(named.output)).toEqual([
      { name: "Mom", key: "5551234567", address: "(555) 123-4567", mobile: true },
      { name: "Mom", key: "5552223333", address: "555 222 3333" },
    ]);
    const quoted = bash(contactsNamedCommand("O'Brien"), { home });
    expect(quoted.output).not.toContain("Error");
    expect(contactsFrom(quoted.output)).toEqual([]);
    const known = bash(contactsForHandlesCommand(["5551234567", "sam@example.com", "5550001111"])!, { home });
    expect(contactsFrom(known.output)).toEqual(expect.arrayContaining([
      { name: "Mom", key: "5551234567", address: "(555) 123-4567", mobile: true },
      { name: "Dentist", key: "5550001111", address: "+1 555 000 1111" },
      { name: "Sam Lee", key: "sam@example.com", address: "Sam@Example.com" },
    ]));
  });

  it("reads one person's texts by name, with names in place of numbers", async () => {
    const asked: MacAsk[] = [];
    const answer = await readTexts({ with: "Mom" }, localMac(home, asked));
    expect(asked).toEqual([{ action: "read_texts", arguments: { with: "Mom" } }]);
    expect(answer).toEqual({ status: 200, body: { texts: [
      { at: "2026-10-01 09:00", from: "Mom", handle: "+15551234567", text: "old news" },
      { at: "2026-10-28 10:00", from: "Mom", handle: "+15551234567", text: "Dinner at 7?" },
      { at: "2026-10-28 10:05", from: "me", to: "Mom", handle: "+15551234567", text: "Sure, see you then" },
    ] } });
    const latest = await readTexts({ limit: 2 }, localMac(home));
    expect(latest.body.texts).toEqual([
      { at: "2026-10-29 08:00", from: "Sam Lee", handle: "sam@example.com", chat: "Climbing", text: "Sunday?" },
      { at: "2026-10-29 08:01", from: "Sam Lee", handle: "sam@example.com", chat: "Climbing", text: "(attachment)" },
    ]);
    expect((await readTexts({ with: "Nobody Here" }, localMac(home))).body).toEqual({ texts: [], note: MAC_MESSAGES_WORDS.noContact("Nobody Here") });
  });

  it("texts someone by their name in Contacts, showing the person the number it will use", async () => {
    const asked: MacAsk[] = [];
    const mac = localMac(home, asked);
    const sending = sendText({ to: "Mom", text: "Bringing tiramisu" }, { ...mac, run: async (operation) => operation.action === "run_command" && operation.command === SEND_TEXT_COMMAND
      ? { content: [{ type: "text", text: JSON.stringify({ command_id: "c2", running: false, exitCode: 0, output: "iMessage" }) }] }
      : await mac.run(operation) });
    expect((await sending).body).toEqual({ text: MAC_MESSAGES_WORDS.sentText("Mom (5551234567)", "iMessage", "Jo's MacBook Air") });
    expect(asked).toEqual([{ action: "send_text", arguments: { to: "Mom (5551234567)", text: "Bringing tiramisu" } }]);
    const unsure = await sendText({ to: "Ana", text: "hi" }, localMac(home, asked));
    expect(unsure).toEqual({ status: 409, body: { error: `${MAC_MESSAGES_WORDS.notSent} ${MAC_MESSAGES_WORDS.manyRecipients("Ana", ["Ana Ruiz 555 444 5555", "Ana Ruiz 555 666 7777"])}` } });
    expect(await sendText({ to: "Nobody Here", text: "hi" }, localMac(home, asked))).toEqual({ status: 404, body: { error: `${MAC_MESSAGES_WORDS.notSent} ${MAC_MESSAGES_WORDS.noRecipient("Nobody Here")}` } });
    expect(asked).toHaveLength(1);
  });
});

describe("choosing who a text goes to from Contacts", () => {
  const mom = { name: "Mom", key: "5551234567", address: "+1 (555) 123-4567" };
  it("takes the one number, prefers a phone to an email and a mobile to other phones, and asks otherwise", () => {
    expect(recipientFrom("Mom", [mom, { ...mom }])).toEqual({ to: "+15551234567", shown: "Mom (+15551234567)" });
    expect(recipientFrom("Mom", [{ name: "Mom", key: "mom@example.com", address: "mom@example.com" }, mom])).toEqual({ to: "+15551234567", shown: "Mom (+15551234567)" });
    expect(recipientFrom("Mom", [{ name: "Mom", key: "5552223333", address: "555 222 3333" }, { ...mom, mobile: true }])).toEqual({ to: "+15551234567", shown: "Mom (+15551234567)" });
    expect(recipientFrom("Mom", [{ name: "Mom", key: "5552223333", address: "555 222 3333" }, mom])).toMatchObject({ status: 409 });
    expect(recipientFrom("Mom", [])).toEqual({ error: MAC_MESSAGES_WORDS.noRecipient("Mom"), status: 404 });
  });
});

describe("words kept in a message's rich body", () => {
  it("reads short and long texts, and marks a text cut short", () => {
    expect(attributedText(typedstream("hi there"))).toBe("hi there");
    const long = "é".repeat(200);
    expect(attributedText(typedstream(long))).toBe(long);
    expect(attributedText(typedstream(long).slice(0, 300))).toMatch(/^é+…$/);
    expect(attributedText("00ff")).toBeNull();
    expect(attributedText(null)).toBeNull();
  });

  it("names people from Contacts only where it knows them", () => {
    const texts = textsFrom(JSON.stringify([
      { at: "2026-10-29 08:01", fromMe: 1, handle: "+15551234567", text: "on my way" },
      { at: "2026-10-29 08:00", fromMe: 0, handle: "+447700900123", text: "where are you?" },
    ]));
    expect(namedTexts(texts, [{ name: "Mom", key: "5551234567", address: "(555) 123-4567" }])).toEqual([
      { at: "2026-10-29 08:00", from: "+447700900123", handle: "+447700900123", text: "where are you?" },
      { at: "2026-10-29 08:01", from: "me", to: "Mom", handle: "+15551234567", text: "on my way" },
    ]);
    expect(contactsFrom(`__LATERDOG_CONTACTS__\nError: unable to open database\n__LATERDOG_CONTACTS__\n[{"person":"","nickname":null,"organization":"Acme","phone":"555 123 4567","email":null,"label":"iPhone"}]\n`))
      .toEqual([{ name: "Acme", key: "5551234567", address: "555 123 4567", mobile: true }]);
  });
});

describe("running a command on the Mac", () => {
  it("starts it, hands over its input, and keeps reading until it ends", async () => {
    const { mac, operations } = scriptedMac([
      { command_id: "c1", running: true, output: "" },
      { command_id: "c1", running: true, output: "Messages is " },
      { command_id: "c1", running: false, exitCode: 0, output: "iMessage" },
    ]);
    expect(await runOnMac(mac, "send", { input: "a\0", waitMs: 60_000 })).toEqual({ finished: true, exitCode: 0, output: "Messages is iMessage" });
    expect(operations.map((operation) => operation.action)).toEqual(["run_command", "command_input", "command_output", "command_output"]);
    expect(operations[0]).toMatchObject({ wait_seconds: 0 });
    expect(operations[1]).toMatchObject({ command_id: "c1", input: "a\0", close_input: true });
  });

  it("stops the command when it runs past its time or the turn ends", async () => {
    let clock = 0;
    const late = scriptedMac([{ command_id: "c1", running: true, output: "" }, { command_id: "c1", running: true, output: "" }]);
    const slow = runOnMac(late.mac, "send", { waitMs: 1_000, now: () => (clock += 600) });
    expect(await slow).toEqual({ finished: false, exitCode: null, output: "" });
    expect(late.operations.at(-1)).toMatchObject({ action: "command_stop", command_id: "c1" });
    const ended = scriptedMac([{ command_id: "c1", running: true, output: "" }], { active: () => false });
    expect(await runOnMac(ended.mac, "read", { waitMs: 60_000 })).toMatchObject({ finished: false });
    expect(ended.operations.map((operation) => operation.action)).toEqual(["run_command", "command_stop"]);
  });
});

describe("sending from the Mac", () => {
  it("sends a text only after the card, and says how it went", async () => {
    const { mac, asked, operations } = scriptedMac([{ command_id: "c1", running: false, exitCode: 0, output: "SMS\n" }]);
    const answer = await sendText({ to: "+1 (555) 123-4567", text: "Running late" }, mac);
    expect(asked).toEqual([{ action: "send_text", arguments: { to: "+15551234567", text: "Running late" } }]);
    expect(operations[0]).toMatchObject({ action: "run_command", command: SEND_TEXT_COMMAND });
    expect(answer).toEqual({ status: 200, body: { text: MAC_MESSAGES_WORDS.sentText("+15551234567", "SMS", "Jo's MacBook Air") } });
  });

  it("runs nothing when the person doesn't allow it", async () => {
    const refusal = Object.assign(new Error("The person didn't allow it."), { status: 403 });
    const { mac, operations } = scriptedMac([], { refuse: refusal });
    await expect(sendText({ to: "+15551234567", text: "hi" }, mac)).rejects.toBe(refusal);
    await expect(sendEmail({ to: ["sam@example.com"], subject: "Hi", body: "hi" }, mac)).rejects.toBe(refusal);
    expect(operations).toEqual([]);
  });

  it("explains what macOS or the Mac needs when sending or reading fails", async () => {
    const blocked = "execution error: Not authorized to send Apple events to Messages. (-1743)";
    expect((await sendText({ to: "+15551234567", text: "hi" }, scriptedMac([{ command_id: "c1", running: false, exitCode: 1, output: blocked }]).mac)).body)
      .toEqual({ error: `${MAC_MESSAGES_WORDS.notSent} ${MAC_MESSAGES_WORDS.automation("Messages")}` });
    expect((await sendEmail({ to: ["sam@example.com"], subject: "Hi", body: "hi" }, scriptedMac([{ command_id: "c1", running: false, exitCode: 1, output: "execution error: Mail has no account to send from. (5001)" }]).mac)).body)
      .toEqual({ error: `${MAC_MESSAGES_WORDS.notSent} ${MAC_MESSAGES_WORDS.noMail}` });
    const denied = 'Error: unable to open database "/Users/jo/Library/Messages/chat.db": authorization denied';
    expect(await readTexts({}, scriptedMac([{ command_id: "c1", running: false, exitCode: 1, output: denied }]).mac))
      .toEqual({ status: 403, body: { error: MAC_MESSAGES_WORDS.fullDiskAccess } });
    expect(macMessagesError("execution error: Messages got an error: Can’t get account 1 whose service type = SMS. (-1728)", "Messages")).toBe(MAC_MESSAGES_WORDS.noSms);
    expect(macMessagesError("something else", "Messages")).toBeNull();
    expect((await sendText({ to: "+15551234567", text: "hi" }, scriptedMac([{ command_id: "c1", running: false, exitCode: 1, output: "execution error: odd (-1)" }]).mac)).body)
      .toEqual({ error: `${MAC_MESSAGES_WORDS.notSent} ${MAC_MESSAGES_WORDS.failed("Messages", "execution error: odd (-1)")}` });
  });
});
