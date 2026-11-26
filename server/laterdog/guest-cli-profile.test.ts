import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { guestCliCredentials } from "./guest-cli-credentials.ts";
import { guestCliSessions } from "./guest-cli-sessions.ts";
import { guestCliBinary, guestCliPreparation } from "./guest-cli-runtime.ts";
import { guestCliDriver, guestCliProfile } from "./guest-cli-profile.ts";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "guest-cli-profile-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function file(name: string, data: string) {
  const path = join(home, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { mode: 0o600 });
  return path;
}

it("sends only the chosen Grok access credential, losing neither the home refresh token nor other profiles", async () => {
  const issuer = "https://auth.x.ai::1234-abc";
  const source = JSON.stringify({ [issuer]: { key: "selected-access", auth_mode: "oidc", expires_at: 5000, refresh_token: "private-refresh", email: "private", keys: ["private"] }, "https://other.invalid": { key: "neighbor" } });
  const path = await file("account/auth.json", source);
  const environment = { HOME: home, GROK_HOME: dirname(path), LATERDOG_ADMIN_TOKEN: "admin" };
  const result = await guestCliCredentials("grokAgent", "selected", environment, 1000);
  expect(JSON.parse(result.files.grok!)).toEqual({ [issuer]: { key: "selected-access", auth_mode: "oidc", expires_at: 5000 } });
  expect(result.environment).toEqual({});
  await expect(guestCliCredentials("grokAgent", "selected", environment, 5000_001)).rejects.toThrow(/current sign-in/);
  expect(await readFile(path, "utf8")).toBe(source);
});

it("ignores ambient account tokens and preserves a symlinked login without reading its target", async () => {
  const path = await file("other/profile.json", JSON.stringify({ secrets: "other" }));
  await mkdir(join(home, ".grok"));
  await symlink(path, join(home, ".grok/auth.json"));
  await expect(guestCliCredentials("grokAgent", "selected", { HOME: home })).rejects.toThrow(/safely/);
  const cursor = await guestCliCredentials("cursorAgent", "cursor", { HOME: home, CURSOR_API_KEY: "only-cursor", OPENAI_API_KEY: "unrelated", LATERDOG_ADMIN_TOKEN: "admin" });
  expect(cursor).toEqual({ environment: { CURSOR_API_KEY: "only-cursor" }, files: {} });
});

it("imports just the identified Grok session and reuses its newer checkpoint on restart", async () => {
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const physical = await import("node:fs/promises").then(fs => fs.realpath(cwd));
  const id = "8c6a1fb9-b17e-4d29-8a20-3448c234e72d";
  const root = ".grok/sessions/" + encodeURIComponent(physical);
  await file(root + "/" + id + "/updates.jsonl", "old turn");
  await file(root + "/unrelated/updates.jsonl", "other chat");
  const turn = { botId: "dog", threadId: "chat", text: "continue", cwd, resumeCursor: id };
  const saved = await guestCliSessions("grokAgent", "one", { HOME: home }, turn, join(home, "data"));
  const checkpoint = join(saved, encodeURIComponent(physical), id, "updates.jsonl");
  expect(await readFile(checkpoint, "utf8")).toBe("old turn");
  await expect(readFile(join(saved, encodeURIComponent(physical), "unrelated/updates.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(checkpoint, "current turn");
  expect(await guestCliSessions("grokAgent", "one", { HOME: home }, turn, join(home, "data"))).toBe(saved);
  expect(await readFile(checkpoint, "utf8")).toBe("current turn");
  await expect(guestCliSessions("grokAgent", "two", { HOME: home }, { ...turn, resumeCursor: "../other" }, join(home, "data"))).rejects.toThrow(/identified/);
});

it("imports the selected Cursor chat including committed WAL data with its writer open", async () => {
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const physical = await import("node:fs/promises").then(fs => fs.realpath(cwd));
  const hash = createHash("md5").update(physical).digest("hex");
  const parent = join(home, ".cursor", "chats", hash, "cursor-id");
  await mkdir(parent, { recursive: true });
  const writer = new DatabaseSync(join(parent, "store.db"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE turn (reply TEXT); INSERT INTO turn VALUES ('original reply')");
    const saved = await guestCliSessions("cursorAgent", "one", { HOME: home }, { botId: "dog", threadId: "chat", text: "continue", cwd, resumeCursor: "cursor-id" }, join(home, "data"));
    const db = new DatabaseSync(join(saved, hash, "cursor-id", "store.db"), { readOnly: true });
    try { expect(db.prepare("SELECT reply FROM turn").get()?.reply).toBe("original reply"); } finally { db.close(); }
  } finally { writer.close(); }
});

it("refuses unrelated executables and leaves unknown engines out of native registration", async () => {
  expect(() => guestCliBinary({ kind: "package", name: "unsafe", binary: "unknown", version: "1.0.0" })).toThrow(/verified/);
  expect(() => guestCliBinary({ kind: "installed", binary: "../bin/custom" })).toThrow(/installed/);
  expect(guestCliPreparation({ kind: "cursor" })).toContain("sha256sum -c");
  expect(guestCliDriver("unregistered")).toBeNull();
  expect(await guestCliProfile("unregistered", { instanceId: "no", displayName: undefined, enabled: true, config: {}, environment: {} }, { threadId: "chat", text: "" })).toBeNull();
});
