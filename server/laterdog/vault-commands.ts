import { randomUUID } from "node:crypto";
import {
  capturedValue,
  CommandSecrets,
  maskValues,
  parseVaultUses,
  secretNameProblem,
  vaultFingerprint,
  wrapVaultCommand,
  type ResolvedUse,
} from "./vault-refs.ts";

export const VAULT_OWNER_ONLY = "Only the owner's own dogs, working for the owner, can use vault items.";

export interface VaultItems {
  owner: boolean;
  by: string;
  secret(name: string): string | null;
  names(): string[];
  save(name: string, value: string, by: string): { replaced: boolean };
}

export type PreparedVault =
  | { ok: false; status: number; error: string }
  | { ok: true; operation: Record<string, unknown>; secrets: string[]; capture?: { name: string; path: string } };

function missing(name: string, items: VaultItems): string {
  const names = items.names();
  return `No vault item named ${name}. ${names.length ? `Saved items: ${names.join(", ")}.` : "None saved yet."} Make one with vault_secret generate, or capture a command's output with vault_capture.`;
}

export function resolveUses(raw: unknown, items: VaultItems): { ok: true; uses: ResolvedUse[] } | { ok: false; status: number; error: string } {
  const parsed = parseVaultUses(raw);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  if (parsed.uses.length && !items.owner) return { ok: false, status: 403, error: VAULT_OWNER_ONLY };
  const uses: ResolvedUse[] = [];
  for (const use of parsed.uses) {
    const value = items.secret(use.name);
    if (value === null) return { ok: false, status: 404, error: missing(use.name, items) };
    uses.push({ ...use, value });
  }
  return { ok: true, uses };
}

export function prepareMacVault(raw: Record<string, unknown>, items: VaultItems, captureId: () => string = randomUUID): PreparedVault {
  const { vault, vault_capture: capture, ...operation } = raw;
  if (vault === undefined && capture === undefined) return { ok: true, operation, secrets: [] };
  if (operation.action !== "run_command" || typeof operation.command !== "string") {
    return { ok: false, status: 400, error: "vault and vault_capture go with action run_command." };
  }
  if (!items.owner) return { ok: false, status: 403, error: VAULT_OWNER_ONLY };
  if (capture !== undefined && secretNameProblem(capture)) return { ok: false, status: 400, error: secretNameProblem(capture)! };
  const resolved = resolveUses(vault, items);
  if (!resolved.ok) return resolved;
  const path = capture === undefined ? undefined : `~/.laterdog-vault-capture-${captureId()}`;
  return {
    ok: true,
    operation: { ...operation, command: wrapVaultCommand(operation.command, resolved.uses, path) },
    secrets: resolved.uses.map((use) => use.value),
    ...(capture !== undefined ? { capture: { name: capture as string, path: path! } } : {}),
  };
}

type McpText = { content?: Array<{ type?: string; text?: string }> };

export function macResultState(result: unknown): { commandId?: string; running?: boolean; body?: Record<string, unknown> } {
  const text = (result as McpText | null)?.content?.[0]?.text;
  if (typeof text !== "string") return {};
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return {
      ...(typeof body.command_id === "string" ? { commandId: body.command_id } : {}),
      ...(typeof body.running === "boolean" ? { running: body.running } : {}),
      body,
    };
  } catch {
    return {};
  }
}

function withNote(result: unknown, note: Record<string, unknown>): unknown {
  const state = macResultState(result);
  if (!state.body) return result;
  const content = [...((result as McpText).content ?? [])];
  content[0] = { type: "text", text: JSON.stringify({ ...state.body, ...note }) };
  return { ...(result as object), content };
}

export async function finishMacVault(
  operation: Record<string, unknown>,
  result: unknown,
  prepared: { secrets: string[]; capture?: { name: string; path: string } },
  items: VaultItems,
  held: CommandSecrets,
  run: (operation: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const state = macResultState(result);
  const commandId = state.commandId ?? (typeof operation.command_id === "string" ? operation.command_id : undefined);
  if (operation.action === "run_command" && commandId && (prepared.secrets.length || prepared.capture)) {
    held.remember(commandId, prepared.secrets, prepared.capture ? { ...prepared.capture, by: items.by } : undefined);
  } else if (commandId && prepared.secrets.length) {
    for (const secret of prepared.secrets) held.add(commandId, secret);
  }
  let note: Record<string, unknown> | undefined;
  const capture = commandId && state.running === false ? held.takeCapture(commandId) : undefined;
  if (capture) {
    let value: string | null = null;
    try {
      const read = macResultState(await run({ action: "read_file", path: capture.path }));
      value = typeof read.body?.content === "string" ? capturedValue(read.body.content) : null;
    } catch {}
    await run({ action: "delete_file", path: capture.path }).catch(() => undefined);
    if (value === null) {
      note = { vault_error: `The command printed nothing to keep, so ${capture.name} was not saved.` };
    } else {
      held.add(commandId!, value);
      const saved = items.save(capture.name, value, capture.by);
      note = { vault_saved: { name: capture.name, fingerprint: vaultFingerprint(value), replaced: saved.replaced } };
    }
  }
  const masked = maskValues(result, [...prepared.secrets, ...held.secrets(commandId)]);
  return note ? withNote(masked, note) : masked;
}
