import type { ValidateFunction } from "ajv";
import { isolatedRemoteCommand, runCommand, screenshotBoat, servedByComputers } from "./computers.ts";
import type { AppConfig } from "./config.ts";
import { CONTROL_REFUSAL_PLAIN } from "./control-client.ts";
import { compileToolSchema } from "./mcp-schema-validator.ts";
import { resolveUses, VAULT_OWNER_ONLY, type VaultItems } from "./laterdog/vault-commands.ts";
import { capturedValue, maskValues, secretNameProblem, vaultFingerprint, VAULT_CAPTURE_SCHEMA, VAULT_USES_SCHEMA, wrapVaultCommand } from "./laterdog/vault-refs.ts";
import { splitTabListing, TAB_TRACKED_TOOLS, withTabListing, type Target } from "./laterdog/cloud-tabs.ts";
import { fillSecureField, parseSecureFormInput, SECURE_FORM_TOOLS, secureFormRequestedText, type SecureFormDesk } from "./laterdog/secure-form.ts";
import { imageFromOutput, pointerTo, scaled, screenSizeCommand, SCREENSHOT_COMMAND, zoomCommand } from "./laterdog/screen-scale.ts";
import { PAGE_TOOL_NAMES, PAGE_TOOLS, pageToolsEnabled, runPageTool, type RemoteExec } from "./laterdog/page-tools.ts";
import { abortableWait, RUN_ACTIONS_TOOL, runActions } from "./laterdog/action-run.ts";

export type { RemoteExec };

const PAGE_TRACKED_TOOLS: ReadonlySet<string> = new Set(["page_open", "page_click", "page_press", "page_back"]);

const coordinate = { type: "integer", minimum: 0, maximum: 32767 };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
export const CLOUD_COMPUTER_TOOLS = [
  tool("screenshot", "See the assigned cloud desktop, scaled to at most 1024 pixels wide on later.dog's own cloud computers. The other computer tools use this image's coordinates."),
  tool("get_screen_size", "Get the width and height of the screenshot image, the coordinates the other computer tools use."),
  tool("zoom", "See one region of the cloud desktop at full detail, to read what the screenshot shows too small. x, y, width and height are in screenshot coordinates; the picture is at most 1024 pixels wide and its own coordinates are not the ones the other tools use.", { x: coordinate, y: coordinate, width: { type: "integer", minimum: 8, maximum: 32767 }, height: { type: "integer", minimum: 8, maximum: 32767 } }, ["x", "y", "width", "height"]),
  tool("click", "Click a point on the cloud desktop.", { x: coordinate, y: coordinate, button: { type: "string", enum: ["left", "middle", "right"] }, count: { type: "integer", minimum: 1, maximum: 3 } }, ["x", "y"]),
  tool("move", "Move the cloud mouse pointer.", { x: coordinate, y: coordinate }, ["x", "y"]),
  tool("drag", "Drag on the cloud desktop.", { x: coordinate, y: coordinate, to_x: coordinate, to_y: coordinate }, ["x", "y", "to_x", "to_y"]),
  tool("type_text", "Type Unicode text into the focused cloud application.", { text: { type: "string", maxLength: 4000 } }, ["text"]),
  tool("key_press", "Press an X11 key or shortcut.", { key: { type: "string", pattern: "^[A-Za-z0-9_+]+$", minLength: 1, maxLength: 100 } }, ["key"]),
  tool("scroll", "Scroll at a point on the cloud desktop.", { x: coordinate, y: coordinate, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 30 } }, ["x", "y", "direction"]),
  RUN_ACTIONS_TOOL,
  tool("open_url", "Request opening an HTTP or HTTPS URL in the cloud desktop browser; inspect the screen to confirm it loaded.", { url: { type: "string", pattern: "^https?://", maxLength: 2000 } }, ["url"]),
  tool("exec", "Run a shell command on the assigned cloud computer. For a token, password or key, pass vault items by name with vault and keep a printed one with vault_capture; never echo, cat or generate a secret in the command itself.", {
    command: { type: "string", minLength: 1, maxLength: 4000 },
    vault: VAULT_USES_SCHEMA,
    vault_capture: VAULT_CAPTURE_SCHEMA,
  }, ["command"]),
  ...SECURE_FORM_TOOLS,
];
export function computerToolsFor(cfg: AppConfig): typeof CLOUD_COMPUTER_TOOLS {
  return pageToolsEnabled(cfg) ? [...CLOUD_COMPUTER_TOOLS, ...PAGE_TOOLS] : CLOUD_COMPUTER_TOOLS;
}
export const CLOUD_COMPUTER_NOT_READY = "The cloud computer is not ready. This call was not performed. Take a fresh screenshot in a moment.";
const SECURE_FORMS_UNAVAILABLE = "Secure Forms are not available in this conversation. Ask the person with request_takeover instead.";
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const buttons: Record<string, number> = { left: 1, middle: 2, right: 3 };
const scrollButtons: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

let validators: Map<string, ValidateFunction> | undefined;

export function cloudComputerCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map([...CLOUD_COMPUTER_TOOLS, ...PAGE_TOOLS].map(entry => [entry.name, compileToolSchema(entry.inputSchema)]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return "Unknown cloud computer tool. Use one of the advertised computer tools.";
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return "Tool arguments do not match the advertised input schema; use its required fields and types.";
  }
  return null;
}

export type CloudComputerResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
  isError?: boolean;
};

export async function runCloudComputerTool(
  cfg: AppConfig,
  boxId: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  onTabs?: (targets: Target[]) => void,
  vault?: VaultItems,
  ownExec?: RemoteExec,
  checkpoint?: () => Promise<string | null>,
): Promise<CloudComputerResult> {
  const exec: RemoteExec = ownExec ?? ((command, abort) => runCommand(cfg, boxId, isolatedRemoteCommand(command), { signal: abort }));
  const fullSize = !ownExec && !servedByComputers(boxId);
  const problem = cloudComputerCallProblem(name, args);
  if (problem) return { isError: true, content: [{ type: "text", text: problem }] };
  signal.throwIfAborted();
  if (name === "run_actions") {
    return runActions({
      steps: args.steps as Array<Record<string, unknown> & { action: string }>,
      reading: args.reading as "page" | "screenshot" | undefined,
      pageTools: pageToolsEnabled(cfg),
      problem: cloudComputerCallProblem,
      run: (step, stepArgs) => runCloudComputerTool(cfg, boxId, step, stepArgs, signal, onTabs, vault, ownExec),
      checkpoint,
      wait: abortableWait(signal),
    });
  }
  if (PAGE_TOOL_NAMES.has(name)) {
    if (!pageToolsEnabled(cfg)) return { isError: true, content: [{ type: "text", text: "Unknown cloud computer tool. Use one of the advertised computer tools." }] };
    const tracked = Boolean(onTabs) && PAGE_TRACKED_TOOLS.has(name);
    const pageExec: RemoteExec = tracked ? async (command, abort) => {
      const raw = await exec(withTabListing(command), abort);
      const split = splitTabListing(raw.stdout);
      if (split.targets) try { onTabs!(split.targets); } catch {}
      return { ...raw, stdout: split.stdout };
    } : exec;
    const page = await runPageTool(pageExec, name, args, signal);
    signal.throwIfAborted();
    return page;
  }
  if (name === "screenshot" && fullSize) {
    const shot = await screenshotBoat(cfg, "", boxId, { signal, nativeSize: true });
    signal.throwIfAborted();
    return { content: [{ type: "image", mimeType: "image/jpeg", data: shot.png }] };
  }
  if (name === "screenshot" || name === "zoom") {
    const shot = await exec(name === "zoom" ? zoomCommand(args as { x: number; y: number; width: number; height: number }, fullSize) : SCREENSHOT_COMMAND, signal);
    signal.throwIfAborted();
    const data = shot.ok ? imageFromOutput(shot.stdout) : null;
    if (!data) return { isError: true, content: [{ type: "text", text: `The screenshot failed: ${(shot.stderr || shot.stdout).trim().slice(-300) || `exit ${shot.exitCode}`}` }] };
    return { content: [{ type: "image", mimeType: "image/jpeg", data }] };
  }
  const a = args;
  const mouse = pointerTo(a.x, a.y);
  let command: string;
  switch (name) {
    case "get_screen_size": command = screenSizeCommand(fullSize); break;
    case "click": command = scaled(`${mouse} && xdotool click --repeat ${a.count ?? 1} --delay 100 ${buttons[String(a.button ?? "left")]}`, fullSize); break;
    case "move": command = scaled(mouse, fullSize); break;
    case "drag": command = scaled(`${mouse} && xdotool mousedown 1 && ${pointerTo(a.to_x, a.to_y)} && xdotool mouseup 1`, fullSize); break;
    case "type_text": command = `printf %s ${quote(Buffer.from(String(a.text)).toString("base64"))} | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v`; break;
    case "key_press": command = `xdotool key --clearmodifiers ${quote(String(a.key))}`; break;
    case "scroll": command = scaled(`${mouse} && xdotool click --repeat ${a.amount ?? 3} --delay 80 ${scrollButtons[String(a.direction)]}`, fullSize); break;
    case "open_url": command = `nohup xdg-open ${quote(String(a.url))} >/dev/null 2>&1 </dev/null &`; break;
    case "exec": {
      if (a.vault === undefined && a.vault_capture === undefined) { command = String(a.command); break; }
      return execWithVault(cfg, boxId, a, signal, vault);
    }
    default: return { isError: true, content: [{ type: "text", text: "Unknown cloud computer tool." }] };
  }
  const tracked = Boolean(onTabs) && TAB_TRACKED_TOOLS.has(name);
  const raw = await exec(tracked ? withTabListing(command) : command, signal);
  signal.throwIfAborted();
  let result = raw;
  if (tracked) {
    const split = splitTabListing(raw.stdout);
    result = { ...raw, stdout: split.stdout };
    if (split.targets) try { onTabs!(split.targets); } catch {}
  }
  if (name === "open_url" && result.ok) return { content: [{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }] };
  return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function execWithVault(cfg: AppConfig, boxId: string, a: Record<string, unknown>, signal: AbortSignal, vault: VaultItems | undefined): Promise<CloudComputerResult> {
  const refuse = (text: string): CloudComputerResult => ({ isError: true, content: [{ type: "text", text }] });
  if (!vault?.owner) return refuse(VAULT_OWNER_ONLY);
  const capture = a.vault_capture;
  if (capture !== undefined && secretNameProblem(capture)) return refuse(secretNameProblem(capture)!);
  const resolved = resolveUses(a.vault, vault);
  if (!resolved.ok) return refuse(resolved.error);
  const secrets = resolved.uses.map((use) => use.value);
  const raw = await runCommand(cfg, boxId, isolatedRemoteCommand(wrapVaultCommand(String(a.command), resolved.uses, capture === undefined ? undefined : "-")), { signal });
  signal.throwIfAborted();
  if (capture === undefined) return maskValues({ isError: !raw.ok, content: [{ type: "text", text: JSON.stringify(raw) }] }, secrets);
  const value = raw.ok ? capturedValue(raw.stdout) : null;
  const shown = { ...raw, stdout: "" };
  if (value === null) {
    return maskValues({ isError: true, content: [{ type: "text", text: JSON.stringify({ ...shown, vault_error: raw.ok ? `The command printed nothing to keep, so ${String(capture)} was not saved.` : `The command failed, so ${String(capture)} was not saved.` }) }] }, [...secrets, raw.stdout.trim()].filter(Boolean));
  }
  const saved = vault.save(capture as string, value, vault.by);
  return maskValues({ content: [{ type: "text", text: JSON.stringify({ ...shown, vault_saved: { name: capture, fingerprint: vaultFingerprint(value), replaced: saved.replaced } }) }] }, [...secrets, value]);
}

export async function cloudComputerRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: {
    cfg: AppConfig;
    boxId(): string | null | undefined;
    gate(): Promise<{ held: boolean; blockedReason?: string }>;
    assertActive(): void;
    signal: AbortSignal;
    secureForms?: SecureFormDesk;
    onTabs?: (boxId: string, targets: Target[]) => void;
    vault?: VaultItems;
  },
): Promise<{ tools: typeof CLOUD_COMPUTER_TOOLS } | CloudComputerResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: computerToolsFor(deps.cfg) };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported computer method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = cloudComputerCallProblem(params.name, args);
  if (problem) return { isError: true, content: [{ type: "text", text: problem }] };
  if (params.name === "request_secure_form") {
    deps.assertActive();
    const desk = deps.secureForms;
    if (!desk) return { isError: true, content: [{ type: "text", text: SECURE_FORMS_UNAVAILABLE }] };
    const input = parseSecureFormInput(args as Record<string, unknown>);
    const opened = "error" in input ? input : desk.open(input);
    if ("error" in opened) return { isError: true, content: [{ type: "text", text: opened.error }] };
    const text = secureFormRequestedText(opened.formId);
    return { content: [{ type: "text", text }] };
  }
  const control = await deps.gate();
  deps.assertActive();
  if (control.held) return { isError: true, content: [{ type: "text", text: control.blockedReason || CONTROL_REFUSAL_PLAIN }] };
  const boxId = deps.boxId();
  if (!boxId) return { isError: true, content: [{ type: "text", text: CLOUD_COMPUTER_NOT_READY }] };
  if (params.name === "fill_secure_field") {
    if (!deps.secureForms) return { isError: true, content: [{ type: "text", text: SECURE_FORMS_UNAVAILABLE }] };
    const filled = await fillSecureField(args as Record<string, unknown>, deps.secureForms, (command) =>
      runCommand(deps.cfg, boxId, isolatedRemoteCommand(command), { signal: deps.signal }), !servedByComputers(boxId));
    deps.signal.throwIfAborted();
    deps.assertActive();
    return { ...(filled.ok ? {} : { isError: true }), content: [{ type: "text", text: filled.text }] };
  }
  const onTabs = deps.onTabs;
  const checkpoint = async () => {
    const now = await deps.gate();
    deps.assertActive();
    return now.held ? now.blockedReason || CONTROL_REFUSAL_PLAIN : null;
  };
  const result = await runCloudComputerTool(deps.cfg, boxId, params.name as string, args as Record<string, unknown>, deps.signal,
    onTabs && ((targets) => onTabs(boxId, targets)), deps.vault, undefined, checkpoint);
  deps.assertActive();
  return result;
}
