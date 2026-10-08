import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";
import { handleToolCall, request as harnessRequest, validateBaseUrl } from "../../scripts/mcp-server.ts";
import { requireSuccess, runCommand } from "./command.ts";
import type { BridgeRequest } from "./bridge-store.ts";

export class BridgePending extends Error {}
interface BridgeConfig { deviceId: string; token: string; origin: string; roots: string[]; allowAssistance: boolean }
interface Receipt { phase: "creating" | "created" | "sending" | "sent" | "done"; taskId?: string; result?: unknown; failed?: boolean }
function privateJson(file: string, value: unknown): void { mkdirSync(dirname(file),{ recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary,JSON.stringify(value,null,2),{ mode: 0o600 }); renameSync(temporary,file); }
export function permittedRoot(root: string, roots: string[]): string {
  const resolved = realpathSync(root);
  if (!roots.some((allowed) => {
    const rel = relative(realpathSync(allowed),resolved); return !rel.startsWith("..") && !isAbsolute(rel);
  })) throw new Error("Local request escapes the paired repository roots");
  return resolved;
}
export async function inspectRepository(root: string, roots: string[]): Promise<unknown> {
  const cwd = permittedRoot(root,roots);
  const status = requireSuccess(await runCommand("git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","status","--short"],{ cwd }),"Read repository status");
  const symbolic = await runCommand("git",["symbolic-ref","--quiet","--short","HEAD"],{ cwd });
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : requireSuccess(await runCommand("git",["rev-parse","--abbrev-ref","HEAD"],{ cwd }),"Read repository branch");
  const remoteResult = await runCommand("git",["remote","get-url","origin"],{ cwd });
  const remote = remoteResult.stdout.trim().replace(/(https?:\/\/)[^/@\s]+@/g,"$1").split(/[?#]/)[0];
  let packageInfo: unknown = null; const packageFile = join(cwd,"package.json");
  if (existsSync(packageFile)) {
    permittedRoot(packageFile,roots);
    const text = readFileSync(packageFile,"utf8"); if (text.length < 100_000) {
      const pkg = JSON.parse(text) as { name?: string; packageManager?: string; engines?: unknown; scripts?: unknown };
      packageInfo = { name: pkg.name, packageManager: pkg.packageManager, engines: pkg.engines, scriptNames: pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts) : [] };
    }
  }
  return { root: cwd, branch, remote: remote.slice(0,1000), status: status.slice(0,12_000), package: packageInfo,
    credentialFilesRead: false, note: "Metadata only. Uncommitted files, .env, Git credentials and provider credentials were not uploaded." };
}
export async function runBridgeRequest(request: BridgeRequest, config: BridgeConfig, receiptFile: string, botId?: string, workspaceUrl?: string): Promise<{ result: unknown; failed: boolean }> {
  if (request.kind === "inspect_repo") return { result: await inspectRepository(request.root,config.roots), failed: false };
  permittedRoot(request.root,config.roots);
  if (!config.allowAssistance || !botId || !workspaceUrl) throw new Error("Configure a local assistance bot and explicit workspace URL after granting this device assistance access");
  const origin = validateBaseUrl(workspaceUrl);
  const fetcher = (path: string, options?: RequestInit) => harnessRequest(path,options,origin);
  let receipt: Receipt | undefined = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile,"utf8")) as Receipt : undefined;
  if (receipt?.phase === "done") return { result: receipt.result, failed: receipt.failed ?? false };
  if (receipt?.phase === "creating" || receipt?.phase === "sending") return { result: { error: "Previous local operation has an uncertain outcome. Inspect the bot conversation; it will not be replayed automatically.", taskId: receipt.taskId }, failed: true };
  if (!receipt) {
    privateJson(receiptFile,{ phase: "creating" });
    const created = await handleToolCall("create_task",{ target_type: "bot", target_id: botId, title: `Local help ${request.id.slice(0,8)}` },fetcher) as { task: { taskId: string } };
    receipt = { phase: "created", taskId: created.task.taskId }; privateJson(receiptFile,receipt);
  }
  if (receipt.phase === "created") {
    receipt.phase = "sending"; privateJson(receiptFile,receipt);
    await handleToolCall("send_bot_message",{ bot_id: botId, task_id: receipt.taskId,
      text: `later.dog local-assistance request ${request.id}. Authorized repository root: ${request.root}. Work only within this root and the already granted computer/browser access. Never upload raw credentials; explain required configuration by name.\n\n${request.instructions}` },fetcher);
    receipt.phase = "sent"; privateJson(receiptFile,receipt);
  }
  const settled = await handleToolCall("wait_for_conversation",{ target_type: "bot", target_id: botId, task_id: receipt.taskId, timeout_seconds: 60 },fetcher) as { state?: string; status?: string };
  const state = settled.state ?? settled.status;
  if (state === "timed-out") throw new BridgePending("Local bot is still working; poll again using its existing task receipt");
  const result = { taskId: receipt.taskId, conversation: settled };
  const failed = state !== "settled"; privateJson(receiptFile,{ ...receipt, phase: "done", result, failed });
  return { result, failed };
}

async function main() {
  const { values } = parseArgs({ options: { "pair-code-file": { type: "string" }, url: { type: "string" }, label: { type: "string" }, "bot-id": { type: "string" }, "workspace-url": { type: "string" } } });
  const dir = process.env.LATERDOG_BRIDGE_DIR ?? join(homedir(),".laterdog","bridge"); const file = join(dir,"device.json");
  if (values["pair-code-file"]) {
    if (!values.url) throw new Error("Pairing requires --url with the supervisor origin");
    const origin = validateBaseUrl(values.url);
    const response = await fetch(`${origin}/v1/bridge/pair`,{ method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: readFileSync(values["pair-code-file"],"utf8").trim(), label: values.label ?? hostname() }), redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Bridge pairing failed; create a fresh pairing code in the workspace");
    privateJson(file,{ ...await response.json() as object, origin }); console.log("Device paired. Credentials are stored locally; the remote service stores their hash.");
  }
  if (!existsSync(file)) throw new Error("Pair this Mac from the workspace before starting its bridge");
  const config = JSON.parse(readFileSync(file,"utf8")) as BridgeConfig; validateBaseUrl(config.origin);
  let stopped = false; process.on("SIGINT",() => { stopped = true; }); process.on("SIGTERM",() => { stopped = true; });
  const send = async (path: string, body: unknown) => {
    const response = await fetch(`${config.origin}/v1/bridge/${path}`,{ method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status === 401 || response.status === 403) { stopped = true; throw new Error("Device pairing was revoked; bridge stopped"); }
    if (!response.ok) throw new Error(`Bridge service unavailable (${response.status})`); return response.json();
  };
  console.log("later.dog local bridge is connected. Offline requests remain queued.");
  while (!stopped) {
    try {
      const { request } = await send("poll",{}) as { request: BridgeRequest | null };
      if (request) {
        let result: { result: unknown; failed: boolean };
        try { result = await runBridgeRequest(request,config,join(dir,"receipts",`${request.id}.json`),values["bot-id"],values["workspace-url"]); }
        catch (error) {
          if (error instanceof BridgePending) throw error;
          result = { failed: true, result: { error: error instanceof Error ? error.message : "Local operation failed" } };
        }
        await send("result",{ id: request.id, ...result });
      }
    } catch (error) { console.error(error instanceof Error ? error.message : "Bridge operation failed"); }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve,5000));
  }
}
if (process.argv[1]?.endsWith("/laterdog/bridge.ts") || process.argv[1]?.endsWith("/laterdog/bridge.js")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "Bridge failed"); process.exitCode = 1; });
