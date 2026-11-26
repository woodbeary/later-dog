import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { currentGrokLogin } from "./guest-grok-login.ts";
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

it("keeps the exact stored account when the native renewal discards an invalid refresh token", async () => {
  const scope = "https://auth.x.ai::abc";
  const input = JSON.stringify({ [scope]: { key: "expired", refresh_token: "invalid", expires_at: 2 } }, null, 2);
  const source = await file(".grok/auth.json", input);
  let count = 0;
  const native = async (_command: string, isolated: string) => {
    count++;
    expect(isolated).not.toBe(home);
    await rm(join(isolated, ".grok", "auth.json"));
  };
  const results = await Promise.all([currentGrokLogin(source, "grok", 3000, native), currentGrokLogin(source, "grok", 3000, native)]);
  expect(results).toEqual([input, input]);
  expect(count).toBe(1);
  expect(await readFile(source, "utf8")).toBe(input);
});

it("publishes a refreshed access and rotated refresh token only for the same selected account", async () => {
  const scope = "https://auth.x.ai::abc";
  const old = { key: "old", refresh_token: "old-refresh", expires_at: 2, user_id: "first" };
  const renewed = { ...old, key: "current", refresh_token: "rotated", expires_at: 7 };
  const source = await file(".grok/auth.json", JSON.stringify({ [scope]: old, untouched: { private: true } }));
  await currentGrokLogin(source, "grok", 3000, async (_command, isolated) => {
    const path = join(isolated, ".grok", "auth.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ [scope]: old });
    await writeFile(path, JSON.stringify({ [scope]: renewed }));
  });
  expect(JSON.parse(await readFile(source, "utf8"))).toEqual({ [scope]: renewed, untouched: { private: true } });
  const safe = await guestCliCredentials("grokAgent", "first", { HOME: home }, 3000);
  expect(JSON.stringify(safe)).toContain("current");
  expect(JSON.stringify(safe)).not.toContain("rotated");
});

it("preserves a newer home login when the selected account changes during renewal", async () => {
  const scope = "https://auth.x.ai::abc";
  const old = { key: "old", refresh_token: "old-refresh", expires_at: 2, user_id: "first" };
  const replacement = JSON.stringify({ [scope]: { key: "different", user_id: "other", expires_at: 9 } });
  const source = await file(".grok/auth.json", JSON.stringify({ [scope]: old }));
  await expect(currentGrokLogin(source, "grok", 3000, async (_command, isolated) => {
    await writeFile(source, replacement);
    await writeFile(join(isolated, ".grok", "auth.json"), JSON.stringify({ [scope]: { ...old, key: "current", expires_at: 7 } }));
  })).rejects.toThrow(/changed during renewal/);
  expect(await readFile(source, "utf8")).toBe(replacement);
});

it("adopts the already renewed private credential after storage prevented publication", async () => {
  const scope = "https://auth.x.ai::abc";
  const original = JSON.stringify({ [scope]: { key: "old", refresh_token: "old-refresh", expires_at: 2, user_id: "one" } });
  const next = { [scope]: { key: "new", refresh_token: "rotated", expires_at: 9, user_id: "one" } };
  const source = await file(".grok/auth.json", original);
  let count = 0;
  const refresh = async (_cli: string, isolated: string) => {
    count++;
    await writeFile(join(isolated, ".grok", "auth.json"), JSON.stringify(next));
  };
  await expect(currentGrokLogin(source, "grok", 3000, refresh, () => { throw Object.assign(new Error("No space left"), { code: "ENOSPC" }); })).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await readFile(source, "utf8")).toBe(original);
  expect(JSON.parse(await currentGrokLogin(source, "grok", 3000, refresh))).toEqual(next);
  expect(JSON.parse(await readFile(source, "utf8"))).toEqual(next);
  expect(count).toBe(1);
  expect(await readdir(join(dirname(source), ".laterdog-renewals"))).toEqual([]);
});
