import { randomUUID } from "node:crypto";
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
  requestId?: string,
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
