import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishMacVault, prepareMacVault, type VaultItems } from "./vault-commands.ts";
import { CommandSecrets, generateSecret, maskValues, parseVaultUses, vaultFingerprint, wrapVaultCommand } from "./vault-refs.ts";
import { VaultStore } from "./vault.ts";

const KEY = Buffer.alloc(32, 7);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "laterdog-vault-refs-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sh = (command: string) => execFileSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, HOME: dir } });

function itemsOver(store: VaultStore, owner = true): VaultItems {
  return {
    owner, by: "nextdoor",
    secret: (name) => store.secret(name),
    names: () => store.secrets().map((item) => item.site),
    save: (name, value, by) => ({ replaced: store.saveSecret(name, value, by).replaced }),
  };
}

const macText = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

describe("generated vault secrets", () => {
  it("are random, the asked length and charset", () => {
    const a = generateSecret(40);
    expect(a).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(generateSecret(40)).not.toBe(a);
    expect(generateSecret(64, "hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are sealed in the vault, listed with who made them, and never offered to a sign-in form", () => {
    const store = new VaultStore(join(dir, "vault.json"), KEY, () => Date.UTC(2026, 10, 7));
    const value = generateSecret(40);
    expect(store.saveSecret("ocjr/OPERATOR_DASHBOARD_TOKEN", value, "nextdoor").replaced).toBe(false);
    expect(readFileSync(join(dir, "vault.json"), "utf8")).not.toContain(value);
    const [item] = store.secrets();
    expect(item).toMatchObject({ site: "ocjr/OPERATOR_DASHBOARD_TOKEN", kind: "secret", createdBy: "nextdoor", note: "Made by nextdoor on 2026-11-07" });
    expect(store.matching("ocjr")).toEqual([]);
    const reopened = new VaultStore(join(dir, "vault.json"), KEY);
    expect(reopened.secret("ocjr/OPERATOR_DASHBOARD_TOKEN")).toBe(value);
    expect(reopened.saveSecret("ocjr/OPERATOR_DASHBOARD_TOKEN", "next", "nextdoor").replaced).toBe(true);
    expect(reopened.secrets()).toHaveLength(1);
    expect(reopened.remove(item!.id)).toBe(true);
    expect(reopened.secret("ocjr/OPERATOR_DASHBOARD_TOKEN")).toBeNull();
  });
});

describe("handing vault items to a command", () => {
  it("rejects a use without a way in", () => {
    expect(parseVaultUses([{ name: "a/b", as: "env" }]).ok).toBe(false);
    expect(parseVaultUses([{ name: "a/b", as: "stdin" }, { name: "c", as: "stdin" }]).ok).toBe(false);
    expect(parseVaultUses([{ name: "has space", as: "stdin" }]).ok).toBe(false);
  });

  it("puts the value on stdin, in an env var and in a mode 600 file, with no copy in the command text", () => {
    const value = "s3cr3t-'quoted'-$HOME-value";
    const command = wrapVaultCommand(
      'test "$TOKEN" = "$(cat)" && cat "$HOME/runner.env" > /dev/null && echo ok',
      [
        { name: "t", as: "stdin", value },
        { name: "t", as: "env", env: "TOKEN", value },
        { name: "t", as: "file", path: "~/runner.env", value },
      ],
    );
    expect(command).not.toContain(value);
    expect(sh(command).trim()).toBe("ok");
    expect(readFileSync(join(dir, "runner.env"), "utf8")).toBe(value);
    expect(statSync(join(dir, "runner.env")).mode & 0o777).toBe(0o600);
  });

  it("captures stdout to a private file instead of the output", () => {
    const command = wrapVaultCommand("echo printed-token; echo note >&2", [], "~/cap");
    expect(sh(`${command} 2>/dev/null`)).toBe("");
    expect(readFileSync(join(dir, "cap"), "utf8")).toBe("printed-token\n");
    expect(statSync(join(dir, "cap")).mode & 0o777).toBe(0o600);
  });

  it("masks the value and its base64 anywhere in a result", () => {
    const masked = maskValues({ output: "x abc123 y", nested: [Buffer.from("abc123").toString("base64")] }, ["abc123"]);
    expect(JSON.stringify(masked)).not.toContain("abc123");
    expect(JSON.stringify(masked)).not.toContain(Buffer.from("abc123").toString("base64"));
  });
});

describe("vault items on the Mac", () => {
  it("are only for the owner's own dogs working for the owner", () => {
    const store = new VaultStore(join(dir, "vault.json"), KEY);
    store.saveSecret("t", "value-1", "nextdoor");
    const prepared = prepareMacVault({ action: "run_command", command: "x", vault: [{ name: "t", as: "stdin" }] }, itemsOver(store, false));
    expect(prepared).toMatchObject({ ok: false, status: 403 });
  });

  it("names the saved items when one is missing", () => {
    const store = new VaultStore(join(dir, "vault.json"), KEY);
    store.saveSecret("ocjr/A", "value-1", "nextdoor");
    const prepared = prepareMacVault({ action: "run_command", command: "x", vault: [{ name: "ocjr/B", as: "stdin" }] }, itemsOver(store));
    expect(prepared.ok).toBe(false);
    expect(!prepared.ok && prepared.error).toContain("ocjr/A");
  });

  it("keeps every copy out of later output from the same command, and saves a capture with only its fingerprint shown", async () => {
    const store = new VaultStore(join(dir, "vault.json"), KEY);
    const value = generateSecret(40);
    store.saveSecret("ocjr/OPERATOR_DASHBOARD_TOKEN", value, "nextdoor");
    const items = itemsOver(store);
    const held = new CommandSecrets();
    const raw = { action: "run_command", command: "cf workers secret put OPERATOR_DASHBOARD_TOKEN", vault: [{ name: "ocjr/OPERATOR_DASHBOARD_TOKEN", as: "stdin" }] };
    expect(JSON.stringify(raw)).not.toContain(value);
    const prepared = prepareMacVault(raw, items, () => "id1");
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.operation.command).not.toContain(value);
    const run = async () => { throw new Error("not used"); };
    const first = await finishMacVault(prepared.operation, macText({ command_id: "c1", running: true, output: `echoed ${value}` }), prepared, items, held, run);
    expect(JSON.stringify(first)).not.toContain(value);
    const later = await finishMacVault({ action: "command_output", command_id: "c1" }, macText({ command_id: "c1", running: false, output: `again ${value}` }), { secrets: [] }, items, held, run);
    expect(JSON.stringify(later)).not.toContain(value);
    expect(JSON.stringify(later)).toContain("again ••••");

    const printed = "cf-printed-token-0123456789";
    const capture = prepareMacVault({ action: "run_command", command: "cf api-tokens create", vault_capture: "cf/NEW_TOKEN" }, items, () => "id2");
    if (!capture.ok) throw new Error(capture.error);
    expect(capture.operation.command).toContain("~/.laterdog-vault-capture-id2".replace("~/", ""));
    const calls: Record<string, unknown>[] = [];
    const macRun = async (operation: Record<string, unknown>) => {
      calls.push(operation);
      return operation.action === "read_file" ? macText({ content: `${printed}\n` }) : macText({ deleted: true });
    };
    const done = await finishMacVault(capture.operation, macText({ command_id: "c2", running: false, exitCode: 0, output: "" }), capture, items, held, macRun);
    expect(JSON.stringify(done)).not.toContain(printed);
    expect(JSON.parse((done as { content: { text: string }[] }).content[0]!.text).vault_saved).toEqual({ name: "cf/NEW_TOKEN", fingerprint: vaultFingerprint(printed), replaced: false });
    expect(calls.map((call) => call.action)).toEqual(["read_file", "delete_file"]);
    expect(store.secret("cf/NEW_TOKEN")).toBe(printed);
    expect(store.secrets().find((item) => item.site === "cf/NEW_TOKEN")?.createdBy).toBe("nextdoor");
  });
});
