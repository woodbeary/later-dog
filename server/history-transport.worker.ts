import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { historyRequest } from "./laterdog/history-request.ts";

parentPort!.on(
  "message",
  async ({
    route,
    body,
    signal,
    port,
  }: {
    route: string;
    body: unknown;
    signal: SharedArrayBuffer;
    port: MessagePort;
  }) => {
    try {
      port.postMessage({ value: await historyRequest(workerData.url, workerData.token, route, body) });
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? error.message : "History request failed" });
    } finally {
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0);
      port.close();
    }
  },
);
