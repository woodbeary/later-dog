import { HISTORY_RECEIPT_PREFIX, receiptDigest } from "../../shared/history-receipt.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { BOOT_CLOUD_SECRETS } from "../cloud-secrets-boot.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";
import { historyRequest } from "./history-request.ts";

const mode = process.env.LATERDOG_HISTORY_MODE;
const generation = process.env.LATERDOG_HISTORY_GENERATION;
const url = process.env.LATERDOG_HISTORY_URL;
const token = BOOT_CLOUD_SECRETS.LATERDOG_HISTORY_TOKEN;
let worker: Worker | undefined;
export function isRemoteHistory() {
  return mode === "remote";
}
export function remoteHistoryGeneration() {
  return generation;
}
function endpoint() {
  if (!generation || !url || !token) throw Error("The selected conversation history store is unavailable");
  return { url, token };
}
function request<T>(route: string, body: unknown): T {
  const options = endpoint();
  if (!worker) {
    const source = new URL("../history-transport.worker.ts", import.meta.url);
    worker = new Worker(existsSync(source) ? source : new URL("./history-transport.worker.js", import.meta.url), {
      workerData: options,
      execArgv: [],
    });
    const current = worker;
    current.on("error", () => {
      if (worker === current) worker = undefined;
    });
    current.on("exit", () => {
      if (worker === current) worker = undefined;
    });
    current.unref();
  }
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  try {
    worker.postMessage({ route, body, signal, port: port2 }, [port2]);
    if (Atomics.wait(new Int32Array(signal), 0, 0, 55_000) === "timed-out")
      throw Error("Conversation history request exceeded its deadline");
    const result = receiveMessageOnPort(port1)?.message;
    if (!result || result.error) throw Error(result?.error ?? "Conversation history returned an incomplete response");
    return result.value as T;
  } finally {
    port1.close();
  }
}
const receiptCache = new Map<string, string>();
let cachedBytes = 0;
function cacheReceipt(hash: string, value: string) {
  if (receiptCache.has(hash) || Buffer.byteLength(value) > 1024 * 1024) return;
  receiptCache.set(hash, value);
  cachedBytes += Buffer.byteLength(value);
  while (cachedBytes > 4 * 1024 * 1024 || receiptCache.size > 128) {
    const oldest = receiptCache.keys().next().value!;
    cachedBytes -= Buffer.byteLength(receiptCache.get(oldest)!);
    receiptCache.delete(oldest);
  }
}
export function storeHistoryReceipt(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  const route = "receipts/" + encodeURIComponent(generation!) + "/" + hash;
  if (!receiptCache.has(hash)) {
    request(route, value);
    cacheReceipt(hash, value);
  }
  return HISTORY_RECEIPT_PREFIX + hash;
}
export function readHistoryReceipt(reference: string): string {
  const hash = receiptDigest(reference),
    cached = receiptCache.get(hash);
  if (cached !== undefined) return cached;
  const value = request<string>("receipts/" + encodeURIComponent(generation!) + "/" + hash, undefined);
  if (typeof value !== "string" || createHash("sha256").update(value).digest("hex") !== hash)
    throw Error("Conversation receipt checksum mismatch");
  cacheReceipt(hash, value);
  return value;
}
export function historyExecute<T>(
  threadId: string,
  operation: HistoryOperation,
  requestId = randomUUID() as string,
): T {
  return request<{ result: T }>("execute", { generation, threadId, operation, requestId }).result;
}
type Page<T> = { items: { threadId: string; result: T }[]; next: string | null };
export function historyMany<T>(
  threadIds: readonly string[] | undefined,
  operation: HistoryOperation,
  requestId: string = randomUUID(),
): { threadId: string; result: T }[] {
  if (threadIds?.length === 0) return [];
  const items: { threadId: string; result: T }[] = [];
  let after: string | null = null;
  do {
    const page: Page<T> = request("many", { generation, threadIds, operation, requestId, after });
    items.push(...page.items);
    if (page.next !== null && page.next === after) throw Error("Conversation history returned a repeated page");
    after = page.next;
  } while (after);
  return items;
}
export async function historyManyAsync<T>(threadIds: readonly string[] | undefined, operation: HistoryOperation) {
  const { url, token } = endpoint();
  const items: { threadId: string; result: T }[] = [];
  let after: string | null = null;
  do {
    const page: Page<T> = await historyRequest(url, token, "many", { generation, threadIds, operation, after });
    items.push(...page.items);
    if (page.next !== null && page.next === after) throw Error("Conversation history returned a repeated page");
    after = page.next;
  } while (after);
  return items;
}
export function checkDualHistory(
  threadId: string,
  operation: HistoryOperation,
  compare: (result: unknown) => boolean,
): void {
  if (mode !== "dual") return;
  const { url, token } = endpoint();
  void historyRequest<{ result: unknown }>(url, token, "execute", { generation, threadId, operation }).then(
    ({ result }) => {
      if (!compare(result)) console.warn("[history] dual read differs for " + threadId);
    },
    () => console.warn("[history] dual read unavailable for " + threadId),
  );
}
